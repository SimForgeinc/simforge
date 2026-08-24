import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Camera,
  Color,
  DirectionalLight,
  FogExp2,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { SurfaceWeatherAppearance } from './surface-materials';

export type WeatherParticleBudget = 'off' | 'low' | 'medium' | 'high';

export interface CityWeatherAppearance {
  readonly backgroundColor: number | null;
  readonly backgroundBlurriness: number;
  readonly backgroundIntensityScale: number;
  readonly environmentIntensityScale: number;
  readonly exposureScale: number;
  readonly fog: {
    readonly color: number;
    readonly visibilityM: number;
    readonly haze: number;
  } | null;
  readonly precipitation: {
    readonly kind: 'rain' | 'snow' | 'sleet';
    readonly intensity: number;
    readonly wind: number;
    readonly budget: WeatherParticleBudget;
  } | null;
  /** Optional camera-centered cloud dome for cloudy and precipitation presets. */
  readonly clouds?: {
    /** 0 is clear sky and 1 is a solid overcast field. */
    readonly coverage: number;
    /** Visual cloud strength, from 0 to 1. Defaults to a coverage-derived value. */
    readonly opacity?: number;
    /** Horizontal cloud-bank drift, from -1 to 1. */
    readonly wind?: number;
    /** Neutral blue-gray is used when omitted. `off` omits the dome entirely. */
    readonly color?: number;
    /** Shader detail tier; defaults to medium. */
    readonly budget?: WeatherParticleBudget;
  } | null;
  readonly sunColor: number;
  readonly sunIntensityScale: number;
  /** Applied by SurfaceMaterialRegistry; retained here so weather is one atomic appearance. */
  readonly surface: SurfaceWeatherAppearance;
}

export const WEATHER_HAZE_OBJECT_NAME = 'city-weather-haze';
export const WEATHER_PRECIPITATION_OBJECT_NAME = 'city-weather-precipitation';
export const WEATHER_CLOUDS_OBJECT_NAME = 'city-weather-clouds';
export const WEATHER_GROUND_IMPACTS_OBJECT_NAME = 'city-weather-ground-impacts';

const WEATHER_ROLE = 'city-weather';
const FOG_VISIBILITY_TRANSMITTANCE = 0.02;
export type ActiveWeatherParticleBudget = Exclude<WeatherParticleBudget, 'off'>;

/**
 * One instanced precipitation draw is used at every active quality tier. The
 * counts stay bounded at twelve thousand quads so dense storms remain viable
 * on integrated GPUs while still reading as volumetric weather.
 */
export const WEATHER_PARTICLE_COUNTS: Readonly<Record<ActiveWeatherParticleBudget, number>> = {
  low: 1_100,
  medium: 4_200,
  high: 12_000,
};

/** A second, bounded draw used only for medium/high precipitation impacts. */
export const WEATHER_GROUND_IMPACT_COUNTS: Readonly<Record<'medium' | 'high', number>> = {
  medium: 700,
  high: 1_600,
};

/**
 * Returns one terrain height for each requested world-space probe. Weather
 * requests a fixed five-point local stencil once per rendered frame.
 */
export type WeatherGroundHeightProvider = (
  worldPositions: readonly Vector3[],
) => readonly (number | null | undefined)[];

/**
 * Converts a meteorological visibility distance to Three's exponential-squared
 * fog density. At `visibilityM`, two percent of the original contrast remains.
 */
export function fogDensityForVisibility(visibilityM: number): number {
  if (!Number.isFinite(visibilityM) || visibilityM <= 0) return 0;
  return Math.sqrt(-Math.log(FOG_VISIBILITY_TRANSMITTANCE)) / visibilityM;
}

interface WeatherSnapshot {
  background: Scene['background'];
  backgroundBlurriness: number;
  backgroundIntensity: number;
  environmentIntensity: number;
  fog: Scene['fog'];
  exposure: number;
  sun: DirectionalLight | null;
  sunColor: Color | null;
  sunIntensity: number | null;
}

type WeatherMesh = Mesh<BufferGeometry, ShaderMaterial>;

const GROUND_IMPACT_GRID_CELL_SIZE_M = 16;
const GROUND_IMPACT_SAMPLE_DISTANCE_M = 22;
const GROUND_IMPACT_GRID_CELLS_PER_AXIS = 5;

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)));
}

function elapsedSeconds(startedAt: number): number {
  return (performance.now() - startedAt) / 1_000;
}

function snapImpactAnchor(cameraPosition: Vector3, target: Vector2): void {
  target.set(
    (Math.floor(cameraPosition.x / GROUND_IMPACT_GRID_CELL_SIZE_M) + 0.5)
      * GROUND_IMPACT_GRID_CELL_SIZE_M,
    (Math.floor(cameraPosition.z / GROUND_IMPACT_GRID_CELL_SIZE_M) + 0.5)
      * GROUND_IMPACT_GRID_CELL_SIZE_M,
  );
}

function fitGroundPlane(
  heights: readonly (number | null | undefined)[],
): { baseY: number; slopeX: number; slopeZ: number } | null {
  const valid = heights.map((height) => (Number.isFinite(height) ? Number(height) : null));
  const finiteHeights = valid.filter((height): height is number => height !== null);
  if (finiteHeights.length === 0) return null;

  const baseY = valid[0] ?? finiteHeights.reduce((total, height) => total + height, 0) / finiteHeights.length;
  const east = valid[1] ?? null;
  const west = valid[2] ?? null;
  const north = valid[3] ?? null;
  const south = valid[4] ?? null;
  const sampleDistance = GROUND_IMPACT_SAMPLE_DISTANCE_M;
  const slopeX = east !== null && west !== null
    ? (east - west) / (sampleDistance * 2)
    : east !== null
      ? (east - baseY) / sampleDistance
      : west !== null
        ? (baseY - west) / sampleDistance
        : 0;
  const slopeZ = north !== null && south !== null
    ? (north - south) / (sampleDistance * 2)
    : north !== null
      ? (north - baseY) / sampleDistance
      : south !== null
        ? (baseY - south) / sampleDistance
        : 0;
  return { baseY, slopeX, slopeZ };
}

function createFullscreenGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([
      -1, -1, 0,
      1, -1, 0,
      1, 1, 0,
      -1, 1, 0,
    ]), 3),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = 1;
  return geometry;
}

function createHaze(
  haze: number,
  color: number,
  timeSeconds: () => number,
): WeatherMesh {
  const geometry = createFullscreenGeometry();
  const material = new ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.035 + clamp(haze, 0, 1) * 0.13 },
      uColor: { value: new Color(color) },
      uCameraPosition: { value: new Vector3() },
      uCameraForward: { value: new Vector3(0, 0, -1) },
      uCameraRight: { value: new Vector3(1, 0, 0) },
      uCameraUp: { value: new Vector3(0, 1, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.9999, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform vec3 uCameraPosition;
      uniform vec3 uCameraForward;
      uniform vec3 uCameraRight;
      uniform vec3 uCameraUp;
      varying vec2 vUv;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.5;
        for (int octave = 0; octave < 3; octave++) {
          value += noise(p) * amplitude;
          p = p * 2.03 + 17.1;
          amplitude *= 0.5;
        }
        return value;
      }

      void main() {
        // This samples a few camera-facing world-space fog banks instead of
        // pinning a noise texture to the screen. FogExp2 still supplies the
        // physically depth-aware baseline; this adds restrained local texture.
        vec2 screen = vUv * 2.0 - 1.0;
        vec3 ray = normalize(uCameraForward + uCameraRight * screen.x * 0.95
          + uCameraUp * screen.y * 0.54);
        float horizon = 1.0 - smoothstep(-0.42, 0.42, ray.y);
        vec3 nearSample = uCameraPosition + ray * 42.0;
        vec3 farSample = uCameraPosition + ray * 128.0;
        vec2 windDrift = vec2(uTime * 0.018, -uTime * 0.006);
        float banks = fbm(nearSample.xz * 0.027 + windDrift);
        float distantBanks = fbm(farSample.xz * 0.012 + windDrift * 0.45);
        float altitudeBreakup = noise(vec2(nearSample.y * 0.018, farSample.y * 0.011));
        float veil = 0.32 + banks * 0.38 + distantBanks * 0.22 + altitudeBreakup * 0.08;
        float groundWeight = mix(1.16, 0.38, smoothstep(0.0, 1.0, vUv.y));
        gl_FragColor = vec4(uColor, veil * horizon * groundWeight * uOpacity);
      }
    `,
  });
  material.name = 'city-weather-haze-material';
  material.userData.cityWeatherEffect = 'haze';

  const mesh = new Mesh(geometry, material);
  mesh.name = WEATHER_HAZE_OBJECT_NAME;
  mesh.frustumCulled = false;
  mesh.renderOrder = 10_000;
  mesh.userData.simforgeRole = WEATHER_ROLE;
  mesh.userData.cityWeatherEffect = 'haze';
  mesh.userData.fogSpace = 'world-anchored-local-banks';
  mesh.userData.haze = clamp(haze, 0, 1);
  mesh.onBeforeRender = (_renderer, _scene, renderCamera) => {
    material.uniforms.uTime!.value = timeSeconds();
    const activeCamera = renderCamera;
    activeCamera.getWorldPosition(material.uniforms.uCameraPosition!.value as Vector3);
    activeCamera.getWorldDirection(material.uniforms.uCameraForward!.value as Vector3);
    (material.uniforms.uCameraRight!.value as Vector3)
      .set(1, 0, 0)
      .transformDirection(activeCamera.matrixWorld);
    (material.uniforms.uCameraUp!.value as Vector3)
      .set(0, 1, 0)
      .transformDirection(activeCamera.matrixWorld);
  };
  return mesh;
}

function createCloudDome(
  clouds: NonNullable<CityWeatherAppearance['clouds']>,
  camera: Camera,
  timeSeconds: () => number,
): WeatherMesh | null {
  const budget = clouds.budget ?? 'medium';
  if (budget === 'off' || clouds.coverage <= 0) return null;

  const coverage = clamp(clouds.coverage, 0, 1);
  const opacity = clamp(clouds.opacity ?? (0.12 + coverage * 0.58), 0, 1);
  const geometry = new SphereGeometry(720, 32, 18);
  const material = new ShaderMaterial({
    transparent: true,
    side: BackSide,
    depthTest: true,
    depthWrite: false,
    defines: { [`CLOUD_${budget.toUpperCase()}`]: 1 },
    uniforms: {
      uTime: { value: 0 },
      uCoverage: { value: coverage },
      uOpacity: { value: opacity },
      uWind: { value: clamp(clouds.wind ?? 0, -1, 1) },
      uColor: { value: new Color(clouds.color ?? 0x8c99a8) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;

      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uTime;
      uniform float uCoverage;
      uniform float uOpacity;
      uniform float uWind;
      uniform vec3 uColor;
      varying vec3 vDirection;

      float hash(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
              mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
          mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
              mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
      }

      float cloudField(vec3 p) {
        float value = noise(p) * 0.56;
        #ifndef CLOUD_LOW
          value += noise(p * 2.02 + vec3(11.7, 4.2, 17.9)) * 0.28;
          value += noise(p * 4.09 + vec3(27.3, 8.1, 3.6)) * 0.16;
        #endif
        #ifdef CLOUD_HIGH
          value += noise(p * 7.97 + vec3(47.1, 12.4, 31.5)) * 0.10;
        #endif
        return value;
      }

      void main() {
        // Direction-space noise has no equirectangular longitude seam while
        // preserving camera-centered, animated multi-scale cloud banks.
        vec3 direction = normalize(vDirection);
        vec3 drift = vec3(
          uTime * (0.002 + abs(uWind) * 0.009) * sign(uWind),
          uTime * 0.0013,
          uTime * 0.0042
        );
        float field = cloudField(direction * vec3(4.8, 2.7, 4.8) + drift);
        float cloudMask = smoothstep(1.0 - uCoverage * 0.86, 1.0 - uCoverage * 0.24, field);
        float horizon = smoothstep(-0.35, 0.24, direction.y);
        float silverLining = smoothstep(0.52, 0.88, field) * (1.0 - cloudMask) * 0.20;
        vec3 color = mix(uColor * 0.72, uColor * 1.12, field + silverLining);
        float alpha = cloudMask * uOpacity * mix(0.46, 1.0, horizon);
        if (alpha <= 0.005) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  material.name = 'city-weather-clouds-material';
  material.userData.cityWeatherEffect = 'clouds';
  material.userData.cloudQuality = budget;

  const mesh = new Mesh(geometry, material);
  mesh.name = WEATHER_CLOUDS_OBJECT_NAME;
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.userData.simforgeRole = WEATHER_ROLE;
  mesh.userData.cityWeatherEffect = 'clouds';
  mesh.userData.cloudCoverage = coverage;
  mesh.userData.cloudQuality = budget;
  mesh.userData.cameraCentered = true;
  mesh.onBeforeRender = (_renderer, _scene, renderCamera) => {
    material.uniforms.uTime!.value = timeSeconds();
    renderCamera.getWorldPosition(mesh.position);
    // onBeforeRender runs after scene projection, so refresh the model and
    // model-view transforms for this very frame after camera-centering.
    mesh.updateMatrixWorld();
    mesh.modelViewMatrix.multiplyMatrices(renderCamera.matrixWorldInverse, mesh.matrixWorld);
  };
  camera.getWorldPosition(mesh.position);
  return mesh;
}

function seededParticleData(count: number): Float32Array {
  const values = new Float32Array(count * 4);
  // A fixed LCG makes particle placement reproducible across browsers and runs.
  let state = 0x6d2b79f5;
  for (let index = 0; index < values.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    values[index] = state / 0x1_0000_0000;
  }
  return values;
}

function groundImpactParticleData(count: number): Float32Array {
  const slotsPerCell = count / (GROUND_IMPACT_GRID_CELLS_PER_AXIS ** 2);
  const values = new Float32Array(count * 4);
  for (let index = 0; index < count; index += 1) {
    const cell = Math.floor(index / slotsPerCell);
    const slot = index % slotsPerCell;
    const offset = index * 4;
    values[offset] = cell % GROUND_IMPACT_GRID_CELLS_PER_AXIS;
    values[offset + 1] = Math.floor(cell / GROUND_IMPACT_GRID_CELLS_PER_AXIS);
    values[offset + 2] = (slot + 0.5) / slotsPerCell;
    values[offset + 3] = slotsPerCell;
  }
  return values;
}

function createGroundImpacts(
  appearance: NonNullable<CityWeatherAppearance['precipitation']>,
  snowDepthM: number,
  camera: Camera,
  groundHeightProvider: WeatherGroundHeightProvider | null,
  timeSeconds: () => number,
): WeatherMesh | null {
  if (
    !groundHeightProvider
    || appearance.budget === 'off'
    || appearance.budget === 'low'
    || appearance.intensity <= 0
  ) return null;

  const count = WEATHER_GROUND_IMPACT_COUNTS[appearance.budget];
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([
      -0.5, 0, -0.5,
      0.5, 0, -0.5,
      0.5, 0, 0.5,
      -0.5, 0, 0.5,
    ]), 3),
  );
  geometry.setAttribute('weatherSeed', new InstancedBufferAttribute(groundImpactParticleData(count), 4));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = count;

  const kindDefine = `WEATHER_${appearance.kind.toUpperCase()}`;
  const gridCellSizeShader = GROUND_IMPACT_GRID_CELL_SIZE_M.toFixed(1);
  const material = new ShaderMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    defines: { [kindDefine]: 1 },
    uniforms: {
      uTime: { value: 0 },
      uImpactAnchor: { value: new Vector2() },
      uGroundY: { value: 0 },
      uGroundSlope: { value: new Vector2() },
      uSnowSurfaceOffset: { value: appearance.kind === 'rain' ? 0 : Math.max(0, finite(snowDepthM, 0)) },
      uVisible: { value: 0 },
      uIntensity: { value: clamp(appearance.intensity, 0, 1) },
      uWind: { value: clamp(appearance.wind, -1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 weatherSeed;
      uniform float uTime;
      uniform float uGroundY;
      uniform vec2 uGroundSlope;
      uniform vec2 uImpactAnchor;
      uniform float uSnowSurfaceOffset;
      uniform float uWind;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;

      float hash31(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.yzx + 33.33);
        return fract((p.x + p.y) * p.z);
      }

      void main() {
        float pace = 12.0;
        float baseSize = 1.15;
        #ifdef WEATHER_SNOW
          pace = 3.4;
          baseSize = 1.85;
        #endif
        #ifdef WEATHER_SLEET
          pace = 8.0;
          baseSize = 0.86;
        #endif

        // Every slot is keyed by absolute grid cell, not camera-relative
        // distance, so crossing a cell boundary only changes the outer strip.
        vec2 localCell = weatherSeed.xy - 2.0;
        vec2 absoluteCell = floor(uImpactAnchor / ${gridCellSizeShader}) + localCell;
        float slot = weatherSeed.z;
        float cellSeed = hash31(vec3(absoluteCell, slot * 31.0));
        float phase = fract(cellSeed + uTime * pace * (0.68 + slot * 0.62));
        float arrival = smoothstep(0.0, 0.12, phase);
        float departure = 1.0 - smoothstep(0.64, 1.0, phase);
        vec2 jitter = vec2(
          hash31(vec3(absoluteCell, slot * 17.0)),
          hash31(vec3(absoluteCell.yx, slot * 29.0))
        ) - 0.5;
        vec2 center = (absoluteCell + 0.5) * ${gridCellSizeShader}
          + jitter * ${((GROUND_IMPACT_GRID_CELL_SIZE_M * 0.78).toFixed(2))};
        center.x += uWind * (slot - 0.5) * 7.0;
        float spread = mix(0.55, 1.55, phase) * mix(0.72, 1.35, slot);
        #ifdef WEATHER_SNOW
          spread = mix(0.28, 1.15, phase) * mix(0.8, 1.45, slot);
        #endif
        vec2 worldXZ = center + position.xz * baseSize * spread;
        float localGroundY = uGroundY + dot(worldXZ - uImpactAnchor, uGroundSlope);
        vec3 worldPosition = vec3(worldXZ.x, localGroundY + uSnowSurfaceOffset + 0.025, worldXZ.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(worldPosition, 1.0);
        vUv = position.xz + 0.5;
        vLife = arrival * departure;
        vSeed = cellSeed;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uVisible;
      uniform float uIntensity;
      varying vec2 vUv;
      varying float vLife;
      varying float vSeed;

      void main() {
        if (uVisible < 0.5 || vLife <= 0.0) discard;
        vec2 centered = vUv - 0.5;
        float distanceToCenter = length(centered);
        float alpha;
        vec3 color;
        #ifdef WEATHER_RAIN
          float outerRing = 1.0 - smoothstep(0.025, 0.10, abs(distanceToCenter - 0.31));
          float innerRing = 1.0 - smoothstep(0.018, 0.07, abs(distanceToCenter - 0.16));
          alpha = max(outerRing * 0.70, innerRing * 0.38);
          color = vec3(0.72, 0.82, 0.90);
        #endif
        #ifdef WEATHER_SLEET
          float ring = 1.0 - smoothstep(0.025, 0.09, abs(distanceToCenter - 0.25));
          float splash = 1.0 - smoothstep(0.09, 0.20, distanceToCenter);
          alpha = max(ring * 0.75, splash * (0.24 + vSeed * 0.18));
          color = mix(vec3(0.69, 0.80, 0.89), vec3(0.92, 0.96, 1.0), vSeed);
        #endif
        #ifdef WEATHER_SNOW
          float puff = 1.0 - smoothstep(0.16, 0.5, distanceToCenter);
          float softEdge = 1.0 - smoothstep(0.0, 0.45, distanceToCenter);
          alpha = puff * (0.40 + softEdge * 0.35);
          color = vec3(0.92, 0.96, 1.0);
        #endif
        if (alpha <= 0.01) discard;
        gl_FragColor = vec4(color, alpha * vLife * uIntensity * 0.62);
      }
    `,
  });
  material.name = `city-weather-${appearance.kind}-ground-impacts-material`;
  material.userData.cityWeatherEffect = 'ground-impacts';
  material.userData.precipitationKind = appearance.kind;

  const mesh = new Mesh(geometry, material);
  mesh.name = WEATHER_GROUND_IMPACTS_OBJECT_NAME;
  mesh.frustumCulled = false;
  mesh.renderOrder = 8_900;
  mesh.userData.simforgeRole = WEATHER_ROLE;
  mesh.userData.cityWeatherEffect = 'ground-impacts';
  mesh.userData.precipitationKind = appearance.kind;
  mesh.userData.particleBudget = appearance.budget;
  mesh.userData.particleCount = count;
  mesh.userData.worldAnchored = true;
  mesh.userData.anchorSpacingM = GROUND_IMPACT_GRID_CELL_SIZE_M;
  mesh.userData.groundHeightSamplesPerFrame = 5;
  mesh.userData.groundPlane = 'five-point-fitted';
  const cameraPosition = new Vector3();
  const impactAnchor = new Vector2();
  const groundSamplePositions = [
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
    new Vector3(),
  ];
  mesh.onBeforeRender = (_renderer, _scene, renderCamera) => {
    const activeCamera = renderCamera ?? camera;
    activeCamera.getWorldPosition(cameraPosition);
    snapImpactAnchor(cameraPosition, impactAnchor);
    groundSamplePositions[0]!.set(impactAnchor.x, 0, impactAnchor.y);
    groundSamplePositions[1]!.set(impactAnchor.x + GROUND_IMPACT_SAMPLE_DISTANCE_M, 0, impactAnchor.y);
    groundSamplePositions[2]!.set(impactAnchor.x - GROUND_IMPACT_SAMPLE_DISTANCE_M, 0, impactAnchor.y);
    groundSamplePositions[3]!.set(impactAnchor.x, 0, impactAnchor.y + GROUND_IMPACT_SAMPLE_DISTANCE_M);
    groundSamplePositions[4]!.set(impactAnchor.x, 0, impactAnchor.y - GROUND_IMPACT_SAMPLE_DISTANCE_M);
    const groundPlane = fitGroundPlane(groundHeightProvider(groundSamplePositions));
    material.uniforms.uTime!.value = timeSeconds();
    material.uniforms.uVisible!.value = groundPlane ? 1 : 0;
    if (groundPlane) {
      (material.uniforms.uImpactAnchor!.value as Vector2).copy(impactAnchor);
      material.uniforms.uGroundY!.value = groundPlane.baseY;
      (material.uniforms.uGroundSlope!.value as Vector2).set(groundPlane.slopeX, groundPlane.slopeZ);
    }
  };
  return mesh;
}

function createPrecipitation(
  appearance: NonNullable<CityWeatherAppearance['precipitation']>,
  camera: Camera,
  timeSeconds: () => number,
): WeatherMesh | null {
  if (appearance.budget === 'off' || appearance.intensity <= 0) return null;

  const count = WEATHER_PARTICLE_COUNTS[appearance.budget];
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0.5, 0.5, 0,
      -0.5, 0.5, 0,
    ]), 3),
  );
  geometry.setAttribute('weatherSeed', new InstancedBufferAttribute(seededParticleData(count), 4));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.instanceCount = count;

  const kindDefine = `WEATHER_${appearance.kind.toUpperCase()}`;
  const material = new ShaderMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    defines: { [kindDefine]: 1 },
    uniforms: {
      uTime: { value: 0 },
      uCameraPosition: { value: new Vector3() },
      uIntensity: { value: clamp(appearance.intensity, 0, 1) },
      uWind: { value: clamp(appearance.wind, -1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec4 weatherSeed;
      uniform float uTime;
      uniform float uIntensity;
      uniform float uWind;
      uniform vec3 uCameraPosition;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vDepth;
      varying float vNearGroundFade;
      varying float vNearCameraFade;
      varying float vSleetIce;

      float hash11(float p) {
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }

      void main() {
        float fallSpeed = 19.0;
        float radius = 54.0;
        float height = 48.0;
        vec2 size = vec2(0.09, 3.7);
        #ifdef WEATHER_SNOW
          fallSpeed = 3.5;
          radius = 42.0;
          height = 38.0;
          size = vec2(0.42, 0.42);
        #endif
        #ifdef WEATHER_SLEET
          fallSpeed = 10.0;
          radius = 49.0;
          height = 43.0;
          size = vec2(0.13, 1.55);
        #endif

        float layer = floor(hash11(weatherSeed.x + weatherSeed.z * 7.31) * 3.0);
        float layerDepth = layer * 0.5;
        float scaleVariation = mix(0.58, 1.52, hash11(weatherSeed.y + weatherSeed.w * 3.7));
        float speedVariation = mix(0.72, 1.34, hash11(weatherSeed.z + weatherSeed.x * 11.1));
        float cycle = fract(weatherSeed.w + uTime * fallSpeed * speedVariation / height);
        float angle = weatherSeed.x * 6.28318530718;
        float radial = sqrt(weatherSeed.y) * mix(radius * 0.30, radius, layerDepth / 1.0);
        vec3 center = uCameraPosition;
        center.x += cos(angle) * radial;
        center.z += sin(angle) * radial;
        center.y += (1.0 - cycle) * height - height * 0.42;
        float gust = sin(uTime * (0.65 + weatherSeed.y) + weatherSeed.x * 21.0);
        float turbulence = sin(uTime * (1.4 + weatherSeed.z * 1.8) + weatherSeed.w * 31.0);
        center.x += uWind * (cycle - 0.5) * (13.0 + layerDepth * 4.0) + gust * 0.65;
        center.z += turbulence * (0.25 + layerDepth * 0.38);
        #ifdef WEATHER_SNOW
          center.x += sin(uTime * 1.1 + weatherSeed.z * 19.0) * (1.1 + scaleVariation * 0.45);
          center.z += cos(uTime * 0.8 + weatherSeed.x * 17.0) * (0.8 + scaleVariation * 0.35);
        #endif

        vSleetIce = 0.0;
        #ifdef WEATHER_SLEET
          // A single instanced layer contains both icy pellets and rain-like
          // streaks, avoiding a second GPU draw for mixed sleet.
          vSleetIce = step(0.58, hash11(weatherSeed.z + weatherSeed.w * 5.3));
          size = mix(size, vec2(0.24, 0.24), vSleetIce);
        #endif

        vec2 corner = position.xy * size * scaleVariation * mix(0.78, 1.18, layerDepth / 1.0);
        #ifdef WEATHER_SNOW
          float spin = uTime * (weatherSeed.z - 0.5) * 2.5 + weatherSeed.x * 6.28318530718;
          corner = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * corner;
        #endif
        #ifdef WEATHER_SLEET
          corner.x += corner.y * (0.1 + uWind * 0.08);
        #endif

        vec4 viewCenter = viewMatrix * vec4(center, 1.0);
        viewCenter.xy += corner;
        gl_Position = projectionMatrix * viewCenter;
        vUv = position.xy + 0.5;
        vSeed = weatherSeed.z;
        vDepth = layerDepth / 1.0;
        // Fade before the local precipitation volume's ground plane. This
        // prevents hard disappearance while remaining independent of terrain.
        vNearGroundFade = 1.0 - smoothstep(0.72, 0.98, cycle);
        // Prevent a camera-local billboard from filling the view when a snow
        // flake happens to pass through the lens volume.
        vNearCameraFade = smoothstep(3.5, 8.5, length(viewCenter.xyz));
        vAlpha = step(weatherSeed.z, uIntensity) * smoothstep(0.0, 0.09, cycle)
          * vNearGroundFade * vNearCameraFade * mix(0.48, 1.0, vDepth);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      varying float vAlpha;
      varying float vSeed;
      varying float vDepth;
      varying float vNearGroundFade;
      varying float vNearCameraFade;
      varying float vSleetIce;

      void main() {
        if (vAlpha <= 0.0) discard;
        vec2 centered = vUv - 0.5;
        float alpha;
        vec3 color;
        #ifdef WEATHER_RAIN
          alpha = 1.0 - smoothstep(0.17, 0.5, abs(centered.x));
          alpha *= 1.0 - smoothstep(0.34, 0.5, abs(centered.y));
          color = vec3(0.66, 0.78, 0.88);
        #endif
        #ifdef WEATHER_SNOW
          float radius = length(centered);
          float flakeAngle = atan(centered.y, centered.x);
          // Six soft radial lobes suggest crystalline structure without the
          // icon-like Cartesian cross silhouette of the previous sprite.
          float sixfold = 0.5 + 0.5 * cos(flakeAngle * 6.0);
          float branchRadius = 0.28 + sixfold * 0.13;
          float core = 1.0 - smoothstep(0.06, 0.19, radius);
          float crystal = 1.0 - smoothstep(branchRadius * 0.64, branchRadius, radius);
          float breakup = 0.78 + 0.22 * sin(flakeAngle * 18.0 + vSeed * 31.0)
            * sin(radius * 36.0 + vSeed * 17.0);
          alpha = max(core * 0.92, crystal * mix(0.24, 0.76, sixfold)) * breakup;
          color = vec3(0.94, 0.97, 1.0);
        #endif
        #ifdef WEATHER_SLEET
          float streak = 1.0 - smoothstep(0.16, 0.48, abs(centered.x));
          streak *= 1.0 - smoothstep(0.28, 0.5, abs(centered.y));
          float pellet = 1.0 - smoothstep(0.24, 0.5, length(centered));
          alpha = mix(streak, pellet, vSleetIce);
          color = mix(vec3(0.70, 0.82, 0.91), vec3(0.94, 0.97, 1.0), vSleetIce);
        #endif
        if (alpha <= 0.01) discard;
        float depthSoftness = mix(0.56, 1.0, vDepth);
        gl_FragColor = vec4(color, alpha * vAlpha * vNearGroundFade * depthSoftness * 0.78);
      }
    `,
  });
  material.name = `city-weather-${appearance.kind}-material`;
  material.userData.cityWeatherEffect = 'precipitation';
  material.userData.precipitationKind = appearance.kind;

  const mesh = new Mesh(geometry, material);
  mesh.name = WEATHER_PRECIPITATION_OBJECT_NAME;
  mesh.frustumCulled = false;
  mesh.renderOrder = 9_000;
  mesh.userData.simforgeRole = WEATHER_ROLE;
  mesh.userData.cityWeatherEffect = 'precipitation';
  mesh.userData.precipitationKind = appearance.kind;
  mesh.userData.particleBudget = appearance.budget;
  mesh.userData.particleCount = count;
  mesh.userData.layers = 3;
  mesh.userData.nearGroundFade = true;
  mesh.userData.nearCameraFade = true;
  mesh.userData.mixedSleet = appearance.kind === 'sleet';
  mesh.onBeforeRender = (_renderer, _scene, renderCamera) => {
    material.uniforms.uTime!.value = timeSeconds();
    (renderCamera ?? camera).getWorldPosition(material.uniforms.uCameraPosition!.value as Vector3);
  };
  return mesh;
}

/** Owns reversible atmospheric scene state and bounded procedural GPU effects. */
export class WeatherController {
  private snapshot: WeatherSnapshot | null = null;
  private clouds: WeatherMesh | null = null;
  private haze: WeatherMesh | null = null;
  private precipitation: WeatherMesh | null = null;
  private pinnedTimeSeconds: number | null = null;
  private groundImpacts: WeatherMesh | null = null;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly camera: Camera,
    private readonly renderer: WebGLRenderer,
    private readonly groundHeightProvider: WeatherGroundHeightProvider | null = null,
  ) {}

  apply(appearance: CityWeatherAppearance, sun: DirectionalLight | null): void {
    if (this.disposed) throw new Error('WeatherController is disposed');

    if (this.snapshot && this.snapshot.sun !== sun) {
      this.restoreSnapshot();
      this.snapshot = null;
    }
    this.snapshot ??= this.captureSnapshot(sun);

    const startedAt = performance.now();
    const timeSeconds = () => this.pinnedTimeSeconds ?? elapsedSeconds(startedAt);
    const nextClouds = appearance.clouds
      ? createCloudDome(appearance.clouds, this.camera, timeSeconds)
      : null;
    const nextHaze = appearance.fog && appearance.fog.haze > 0
      ? createHaze(appearance.fog.haze, appearance.fog.color, timeSeconds)
      : null;
    const nextPrecipitation = appearance.precipitation
      ? createPrecipitation(appearance.precipitation, this.camera, timeSeconds)
      : null;
    const nextGroundImpacts = appearance.precipitation
      ? createGroundImpacts(
        appearance.precipitation,
        appearance.surface.snowDepthM ?? 0,
        this.camera,
        this.groundHeightProvider,
        timeSeconds,
      )
      : null;

    this.removeEffects();
    this.clouds = nextClouds;
    this.haze = nextHaze;
    this.precipitation = nextPrecipitation;
    this.groundImpacts = nextGroundImpacts;
    if (nextClouds) this.scene.add(nextClouds);
    if (nextHaze) this.scene.add(nextHaze);
    if (nextPrecipitation) this.scene.add(nextPrecipitation);
    if (nextGroundImpacts) this.scene.add(nextGroundImpacts);

    const baseline = this.snapshot;
    this.scene.background = appearance.backgroundColor === null
      ? baseline.background
      : new Color(appearance.backgroundColor);
    this.scene.backgroundBlurriness = clamp(appearance.backgroundBlurriness, 0, 1);
    this.scene.backgroundIntensity = baseline.backgroundIntensity
      * Math.max(0, finite(appearance.backgroundIntensityScale, 1));
    this.scene.environmentIntensity = baseline.environmentIntensity
      * Math.max(0, finite(appearance.environmentIntensityScale, 1));
    this.renderer.toneMappingExposure = baseline.exposure
      * Math.max(0, finite(appearance.exposureScale, 1));
    this.scene.fog = appearance.fog
      ? new FogExp2(
        appearance.fog.color,
        fogDensityForVisibility(appearance.fog.visibilityM),
      )
      : null;
    if (sun) {
      sun.color.setHex(appearance.sunColor);
      sun.intensity = (baseline.sunIntensity ?? sun.intensity)
        * Math.max(0, finite(appearance.sunIntensityScale, 1));
    }
  }

  /**
   * Pin procedural weather animation to scenario time for deterministic capture.
   * Passing `null` resumes the normal performance-clock animation.
   */
  setTimeSeconds(timeSeconds: number | null): void {
    if (timeSeconds !== null && (!Number.isFinite(timeSeconds) || timeSeconds < 0)) {
      throw new RangeError('Weather time must be null or a finite non-negative number');
    }
    this.pinnedTimeSeconds = timeSeconds;
  }

  clear(): void {
    this.removeEffects();
    this.restoreSnapshot();
    this.snapshot = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }

  private captureSnapshot(sun: DirectionalLight | null): WeatherSnapshot {
    return {
      background: this.scene.background,
      backgroundBlurriness: this.scene.backgroundBlurriness,
      backgroundIntensity: this.scene.backgroundIntensity,
      environmentIntensity: this.scene.environmentIntensity,
      fog: this.scene.fog,
      exposure: this.renderer.toneMappingExposure,
      sun,
      sunColor: sun?.color.clone() ?? null,
      sunIntensity: sun?.intensity ?? null,
    };
  }

  private restoreSnapshot(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.scene.background = snapshot.background;
    this.scene.backgroundBlurriness = snapshot.backgroundBlurriness;
    this.scene.backgroundIntensity = snapshot.backgroundIntensity;
    this.scene.environmentIntensity = snapshot.environmentIntensity;
    this.scene.fog = snapshot.fog;
    this.renderer.toneMappingExposure = snapshot.exposure;
    if (snapshot.sun && snapshot.sunColor && snapshot.sunIntensity !== null) {
      snapshot.sun.color.copy(snapshot.sunColor);
      snapshot.sun.intensity = snapshot.sunIntensity;
    }
  }

  private removeEffects(): void {
    for (const mesh of [this.clouds, this.haze, this.precipitation, this.groundImpacts]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.onBeforeRender = () => undefined;
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.clouds = null;
    this.haze = null;
    this.precipitation = null;
    this.groundImpacts = null;
  }
}
