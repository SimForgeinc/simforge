import {
  Color,
  MathUtils,
  PMREMGenerator,
  Scene,
  Vector3,
  type IUniform,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

/**
 * Layer the atmosphere is drawn on.
 *
 * The sky is a screen-filling dome, so a depth, LiDAR or instance-id pass that
 * rendered it would report a hit at dome distance for every ray that misses the
 * world. Sensor passes build their own cameras, and a `Camera` enables only
 * layer 0 by default, so putting the dome on a non-default layer excludes it
 * from every such pass by construction — no cooperation required from the
 * caller that owns the sensor camera.
 *
 * Nothing else in the stack assigns three.js layers; the main viewport camera
 * opts in explicitly.
 */
export const ATMOSPHERE_LAYER = 1;

/**
 * Fraction of the camera's far plane the dome is drawn at.
 *
 * The dome is geometry, so its vertices are clipped by the far plane like
 * anything else — a dome parked past it renders nothing at all. It is also
 * recentred on the camera every frame, so this only has to be far enough away
 * to sit behind the world, not large enough to enclose the map.
 */
const SKY_RADIUS_FAR_FRACTION = 0.6;

/** Fallback radius before a camera has declared its far plane. */
const DEFAULT_SKY_RADIUS = 3600;

/** Sun elevation (degrees) below which the sun contributes no direct light. */
const CIVIL_TWILIGHT_DEG = -6;

/**
 * Angle the baked IBL is allowed to drift from the live sun before it is
 * rebuilt. A PMREM convolution is ~2-4 ms, which is affordable on a weather or
 * clock change and far too expensive per frame; 1.5 degrees is below the
 * threshold where the ambient term visibly steps.
 */
const IBL_SUN_TOLERANCE_RAD = MathUtils.degToRad(1.5);

export interface SkyAppearance {
  /**
   * Aerosol load. ~2 is a clear day, ~10 reads as haze, 20+ as overcast.
   * Raising it also flattens the sun's glow into a broad bright field.
   */
  readonly turbidity: number;
  /** Molecular scattering. Lower values drain the blue out toward grey. */
  readonly rayleigh: number;
  readonly mieCoefficient: number;
  readonly mieDirectionalG: number;
  /** Flat colour mixed over the scattering result; how overcast is expressed. */
  readonly tint: number | null;
  /** 0..1 weight for `tint`. */
  readonly tintAmount: number;
}

export const CLEAR_SKY: SkyAppearance = {
  turbidity: 2.4,
  rayleigh: 1.8,
  mieCoefficient: 0.005,
  mieDirectionalG: 0.8,
  tint: null,
  tintAmount: 0,
};

/**
 * Sky appearance for a weather state.
 *
 * `haze` and an authored background colour are what the editor's weather model
 * already produces, so overcast is derived from them rather than adding a
 * second, redundant weather vocabulary to this package.
 */
export function skyAppearanceForWeather(input: {
  readonly haze: number;
  readonly backgroundColor: number | null;
}): SkyAppearance {
  const haze = Number.isFinite(input.haze) ? Math.min(1, Math.max(0, input.haze)) : 0;
  return {
    turbidity: CLEAR_SKY.turbidity + haze * 22,
    rayleigh: CLEAR_SKY.rayleigh * (1 - 0.75 * haze),
    mieCoefficient: CLEAR_SKY.mieCoefficient,
    // A tighter phase function under haze keeps the overcast dome from
    // developing a false directional hotspot where the sun sits.
    mieDirectionalG: CLEAR_SKY.mieDirectionalG - 0.3 * haze,
    tint: input.backgroundColor,
    // Only overcast pulls the sky toward the authored flat colour. On a clear
    // day the scattering model is the more accurate description of the sky, and
    // tinting it merely desaturates a blue sky to haze.
    tintAmount: input.backgroundColor === null ? 0 : 0.72 * haze,
  };
}

/** Direct-sun fraction for an elevation, reaching 0 through civil twilight. */
export function sunElevationFalloff(elevationDeg: number): number {
  if (!Number.isFinite(elevationDeg)) return 1;
  if (elevationDeg <= CIVIL_TWILIGHT_DEG) return 0;
  if (elevationDeg >= 0) return 1;
  return (elevationDeg - CIVIL_TWILIGHT_DEG) / -CIVIL_TWILIGHT_DEG;
}

/** True when the IBL baked for `baked` no longer represents `live`. */
export function environmentNeedsRebuild(
  baked: { readonly sun: Vector3; readonly key: string } | null,
  live: { readonly sun: Vector3; readonly key: string },
): boolean {
  if (!baked) return true;
  if (baked.key !== live.key) return true;
  return baked.sun.angleTo(live.sun) > IBL_SUN_TOLERANCE_RAD;
}

const TINT_DECL = /* glsl */ `
uniform vec3 uSkyTint;
uniform float uSkyTintAmount;
`;

interface SkyUniforms {
  readonly turbidity: IUniform<number>;
  readonly rayleigh: IUniform<number>;
  readonly mieCoefficient: IUniform<number>;
  readonly mieDirectionalG: IUniform<number>;
  readonly sunPosition: IUniform<Vector3>;
  readonly uSkyTintAmount: IUniform<number>;
  /**
   * Upstream advises hiding the sun disc while baking an environment map: the
   * disc is ~19000x the sky's radiance, and convolving it produces a hotspot
   * artifact rather than usable ambient light.
   */
  readonly showSunDisc: IUniform<number>;
  /**
   * Sky-shader clouds, held at zero coverage.
   *
   * `WeatherController` already owns an animated cloud dome tied to the
   * precipitation and fidelity budgets. Leaving the shader's own clouds at the
   * upstream 0.4 default would put two independent cloud systems in the same
   * sky, so this one stays off and weather remains the single author.
   */
  readonly cloudCoverage: IUniform<number>;
}

/**
 * Resolves one uniform of the `Sky` shader.
 *
 * `ShaderMaterial.uniforms` is an index signature, so every read is optional to
 * the compiler. Failing loudly once at construction is better than silently
 * dropping writes if a three upgrade renames a uniform.
 */
function requireUniform<T>(
  uniforms: Record<string, IUniform | undefined>,
  name: string,
): IUniform<T> {
  const uniform = uniforms[name];
  if (!uniform) throw new Error(`Sky shader is missing the '${name}' uniform`);
  // Names and value types are fixed by `Sky.SkyShader`, which we assert above.
  const typed = uniform as IUniform<T>;
  return typed;
}

/**
 * Sun-driven atmosphere, and the image-based light derived from it.
 *
 * Replaces a shipped HDRI: the dome is generated from the sun direction, so
 * time of day and weather move the sky and the ambient light together, and a
 * map that ships no environment asset is lit correctly anyway.
 */
export class SkyDome {
  readonly mesh: Sky;
  private readonly uniforms: SkyUniforms;
  private readonly tint = new Color(0xffffff);
  private appearance: SkyAppearance = CLEAR_SKY;
  /** Unit vector pointing *at* the sun (the shader's convention). */
  private readonly sunPosition = new Vector3(0, 1, 0);
  private pmrem: PMREMGenerator | null = null;
  private bakeScene: Scene | null = null;
  private environment: Texture | null = null;
  private baked: { sun: Vector3; key: string } | null = null;
  private radius = DEFAULT_SKY_RADIUS;

  constructor() {
    this.mesh = new Sky();
    this.mesh.name = 'sky';
    this.mesh.userData.uniscenariosRole = 'city-sky';
    this.mesh.scale.setScalar(this.radius);
    this.mesh.frustumCulled = false;
    // Drawn before the world so the depth-tested world overwrites it, and the
    // dome never pays a full-screen fill against geometry it sits behind.
    this.mesh.renderOrder = -1;
    this.mesh.layers.set(ATMOSPHERE_LAYER);
    this.mesh.updateMatrixWorld(true);

    const material = this.mesh.material;
    material.uniforms.uSkyTint = { value: this.tint };
    material.uniforms.uSkyTintAmount = { value: 0 };
    const tinted = material.fragmentShader.replace(
      'gl_FragColor = vec4( texColor, 1.0 );',
      'gl_FragColor = vec4( mix( texColor, uSkyTint * max( texColor, vec3( 0.02 ) ), uSkyTintAmount ), 1.0 );',
    );
    if (tinted === material.fragmentShader) {
      // A silently unpatched shader would drop overcast tinting with no error,
      // so fail loudly if three renames the final colour write again.
      throw new Error('Sky shader colour write not found; the tint patch did not apply');
    }
    material.fragmentShader = TINT_DECL + tinted;
    this.uniforms = {
      turbidity: requireUniform<number>(material.uniforms, 'turbidity'),
      rayleigh: requireUniform<number>(material.uniforms, 'rayleigh'),
      mieCoefficient: requireUniform<number>(material.uniforms, 'mieCoefficient'),
      mieDirectionalG: requireUniform<number>(material.uniforms, 'mieDirectionalG'),
      sunPosition: requireUniform<Vector3>(material.uniforms, 'sunPosition'),
      uSkyTintAmount: requireUniform<number>(material.uniforms, 'uSkyTintAmount'),
      showSunDisc: requireUniform<number>(material.uniforms, 'showSunDisc'),
      cloudCoverage: requireUniform<number>(material.uniforms, 'cloudCoverage'),
    };
    this.uniforms.cloudCoverage.value = 0;
    this.setAppearance(CLEAR_SKY);
  }

  /**
   * Sizes the dome to a camera's far plane.
   *
   * A dome larger than the frustum is clipped away entirely and renders
   * nothing, which is indistinguishable from a missing sky.
   */
  fitToCamera(far: number): void {
    const radius = Number.isFinite(far) && far > 0
      ? far * SKY_RADIUS_FAR_FRACTION
      : DEFAULT_SKY_RADIUS;
    if (radius === this.radius) return;
    this.radius = radius;
    this.mesh.scale.setScalar(radius);
  }

  /**
   * Recentres the dome on the viewpoint.
   *
   * The dome is smaller than the map, so it has to travel with the camera or
   * the camera would fly through it. The shader shades by view direction, so
   * moving the dome does not move the sky.
   */
  follow(cameraPosition: Vector3): void {
    this.mesh.position.copy(cameraPosition);
  }

  /** Radius the dome is currently drawn at. */
  currentRadius(): number {
    return this.radius;
  }

  /**
   * Aims the dome from the direction sunlight *travels*, which is how the
   * manifest and `DirectionalLight` both express it.
   */
  setSunTravelDirection(travel: Vector3): void {
    if (travel.lengthSq() === 0) return;
    this.sunPosition.copy(travel).normalize().negate();
    this.uniforms.sunPosition.value.copy(this.sunPosition);
  }

  /** Unit vector pointing at the sun. */
  sunDirection(): Vector3 {
    return this.sunPosition.clone();
  }

  /** Sun elevation in degrees above the horizon; negative below it. */
  sunElevationDeg(): number {
    return MathUtils.radToDeg(Math.asin(MathUtils.clamp(this.sunPosition.y, -1, 1)));
  }

  setAppearance(appearance: SkyAppearance): void {
    this.appearance = appearance;
    this.uniforms.turbidity.value = Math.max(0, appearance.turbidity);
    this.uniforms.rayleigh.value = Math.max(0, appearance.rayleigh);
    this.uniforms.mieCoefficient.value = Math.max(0, appearance.mieCoefficient);
    this.uniforms.mieDirectionalG.value = MathUtils.clamp(appearance.mieDirectionalG, 0, 0.999);
    if (appearance.tint === null) {
      this.uniforms.uSkyTintAmount.value = 0;
    } else {
      this.tint.setHex(appearance.tint);
      this.uniforms.uSkyTintAmount.value = MathUtils.clamp(appearance.tintAmount, 0, 1);
    }
  }

  /** Live scattering values, for tests and diagnostics. */
  uniformValues(): {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
    tintAmount: number;
  } {
    return {
      turbidity: this.uniforms.turbidity.value,
      rayleigh: this.uniforms.rayleigh.value,
      mieCoefficient: this.uniforms.mieCoefficient.value,
      mieDirectionalG: this.uniforms.mieDirectionalG.value,
      tintAmount: this.uniforms.uSkyTintAmount.value,
    };
  }

  private appearanceKey(): string {
    const a = this.appearance;
    return [
      a.turbidity.toFixed(3),
      a.rayleigh.toFixed(3),
      a.mieCoefficient.toFixed(4),
      a.mieDirectionalG.toFixed(3),
      a.tint ?? -1,
      a.tintAmount.toFixed(3),
    ].join('|');
  }

  /**
   * PMREM-convolved environment for the current sky, rebuilt only when the sun
   * or the sky parameters have moved enough to matter.
   *
   * The dome is baked at unit scale: `PMREMGenerator` renders with its own
   * near/far, and a 450 km box would be clipped away entirely. The shader reads
   * only the view direction, so scale does not change the result.
   */
  environmentTexture(renderer: WebGLRenderer): Texture {
    const live = { sun: this.sunPosition, key: this.appearanceKey() };
    if (this.environment && !environmentNeedsRebuild(this.baked, live)) return this.environment;

    this.pmrem ??= new PMREMGenerator(renderer);
    const bakeScene = (this.bakeScene ??= new Scene());
    const previousParent = this.mesh.parent;
    const previousLayers = this.mesh.layers.mask;
    const previousPosition = this.mesh.position.clone();
    // PMREM renders through cube cameras that only see layer 0.
    this.mesh.layers.enable(0);
    // Baked at unit scale about the origin: the cube cameras use their own
    // near/far, and the dome's real radius sits outside them.
    this.mesh.scale.setScalar(1);
    this.mesh.position.set(0, 0, 0);
    // Convolving the solar disc leaves a hotspot instead of ambient light.
    this.uniforms.showSunDisc.value = 0;
    this.mesh.updateMatrixWorld(true);
    bakeScene.add(this.mesh);
    try {
      const target = this.pmrem.fromScene(bakeScene, 0, 0.1, 10);
      this.environment?.dispose();
      this.environment = target.texture;
      this.baked = { sun: this.sunPosition.clone(), key: live.key };
    } finally {
      bakeScene.remove(this.mesh);
      this.mesh.layers.mask = previousLayers;
      this.mesh.scale.setScalar(this.radius);
      this.mesh.position.copy(previousPosition);
      this.mesh.updateMatrixWorld(true);
      if (previousParent) previousParent.add(this.mesh);
      this.uniforms.showSunDisc.value = 1;
    }
    return this.environment!;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.environment?.dispose();
    this.environment = null;
    this.baked = null;
    this.pmrem?.dispose();
    this.pmrem = null;
    this.bakeScene = null;
  }
}
