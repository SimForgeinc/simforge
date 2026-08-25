/**
 * simforge.road-detail/v1 generator core (see docs/road-detail.md).
 *
 * Everything here is a pure, deterministic function of (lane polygons,
 * lane widths, seed, resolution): seeded integer-hash noise, no wall clock,
 * no Math.random, no iteration-order dependence (features are processed in
 * input order; the input is the checksummed map bundle).
 *
 * Outputs, all in tile space (world-XZ bounds -> texture UV):
 *   splat RGBA — R: variant A weight (aged asphalt), G: variant B weight
 *     (concrete repair), B: wear (wheel-track polish + center oil band),
 *     A: lane-marking erosion.
 *   decal overlay RGBA — pre-composited stamps (cracks / patch outlines /
 *     oil blobs / stains) from the self-made procedural atlas; straight
 *     alpha over the road albedo.
 *   decal atlas RGBA — 2x2 grid of 256 px stamps; R carries shade, A shape.
 */

// ---------------------------------------------------------------------------
// Deterministic RNG + noise
// ---------------------------------------------------------------------------

/** splitmix32: deterministic stream of floats in [0,1). */
export function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return (t >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for stable per-lane sub-seeds. */
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Bilinear value noise, worldMeters / wavelength lattice. */
export function valueNoise(x, z, wavelength, seed) {
  const fx = x / wavelength;
  const fz = z / wavelength;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ux = smooth(fx - ix);
  const uz = smooth(fz - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** 3-octave fbm of valueNoise, in [0,1). */
export function fbm(x, z, wavelength, seed) {
  return (
    valueNoise(x, z, wavelength, seed) * 0.5 +
    valueNoise(x, z, wavelength / 2.3, seed ^ 0x51ed) * 0.3 +
    valueNoise(x, z, wavelength / 5.1, seed ^ 0x9b3c) * 0.2
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function distToRing(x, z, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [x1, z1] = ring[j];
    const [x2, z2] = ring[i];
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - x1) * dx + (z - z1) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = x1 + t * dx - x;
    const pz = z1 + t * dz - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function ringBBox(ring) {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

/** Rejection-sample an interior point (deterministic via rng stream). */
function interiorPoint(ring, bbox, rng) {
  for (let tries = 0; tries < 30; tries += 1) {
    const x = bbox.minX + rng() * (bbox.maxX - bbox.minX);
    const z = bbox.minZ + rng() * (bbox.maxZ - bbox.minZ);
    if (pointInRing(x, z, ring)) return { x, z };
  }
  // Fallback: vertex centroid.
  let cx = 0;
  let cz = 0;
  for (const [x, z] of ring) {
    cx += x;
    cz += z;
  }
  return { x: cx / ring.length, z: cz / ring.length };
}

// ---------------------------------------------------------------------------
// Decal atlas (self-made, procedural, CC0-equivalent by construction)
// ---------------------------------------------------------------------------

export const ATLAS_CELL = 256;
export const ATLAS_GRID = 2;
export const ATLAS_STAMPS = ['crack', 'patch', 'oil', 'stain'];
const ATLAS_SEED = 0xa71a5;

function cellBrush(cell, cx, cz, radius, value) {
  const r = Math.max(1, radius);
  const x0 = Math.max(0, Math.floor(cx - r * 3));
  const x1 = Math.min(ATLAS_CELL - 1, Math.ceil(cx + r * 3));
  const z0 = Math.max(0, Math.floor(cz - r * 3));
  const z1 = Math.min(ATLAS_CELL - 1, Math.ceil(cz + r * 3));
  for (let z = z0; z <= z1; z += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - cx;
      const dz = z - cz;
      const g = value * Math.exp(-(dx * dx + dz * dz) / (2 * r * r));
      const i = z * ATLAS_CELL + x;
      if (g > cell[i]) cell[i] = g;
    }
  }
}

function stampCrack(cell, rng) {
  const branches = [{ x: 30 + rng() * 40, z: 30 + rng() * 40, ang: rng() * Math.PI * 2 }];
  while (branches.length > 0) {
    const b = branches.pop();
    let { x, z, ang } = b;
    const steps = 24 + Math.floor(rng() * 30);
    for (let s = 0; s < steps; s += 1) {
      ang += (rng() - 0.5) * 0.9;
      const step = 3 + rng() * 4;
      x += Math.cos(ang) * step;
      z += Math.sin(ang) * step;
      if (x < 8 || x > ATLAS_CELL - 8 || z < 8 || z > ATLAS_CELL - 8) break;
      cellBrush(cell, x, z, 1.1 + rng() * 1.3, 0.9 - s / (steps * 1.6));
      if (rng() < 0.06 && branches.length < 5) {
        branches.push({ x, z, ang: ang + (rng() < 0.5 ? 1 : -1) * (0.7 + rng() * 0.6) });
      }
    }
  }
}

function stampPatch(cell, rng) {
  // Rounded-rectangle outline band (repair patch edge).
  const inset = 28 + rng() * 10;
  const half = ATLAS_CELL / 2;
  const w = 6 + rng() * 3;
  for (let z = 0; z < ATLAS_CELL; z += 1) {
    for (let x = 0; x < ATLAS_CELL; x += 1) {
      const dx = Math.abs(x - half) - (half - inset);
      const dz = Math.abs(z - half) - (half - inset);
      const outside = Math.hypot(Math.max(dx, 0), Math.max(dz, 0));
      const insideD = Math.min(Math.max(dx, dz), 0);
      const sdf = outside + insideD; // rounded-rect signed distance
      const band = Math.exp(-(sdf * sdf) / (2 * w * w));
      const i = z * ATLAS_CELL + x;
      if (band > cell[i]) cell[i] = band * 0.9;
    }
  }
}

function stampOil(cell, rng) {
  const cx = ATLAS_CELL / 2;
  const seed = Math.floor(rng() * 0xffff);
  for (let z = 0; z < ATLAS_CELL; z += 1) {
    for (let x = 0; x < ATLAS_CELL; x += 1) {
      const r = Math.hypot(x - cx, z - cx) / (ATLAS_CELL * 0.42);
      const wobble = 0.55 + 0.45 * fbm(x, z, 90, seed);
      const v = Math.max(0, 1 - r / wobble);
      const i = z * ATLAS_CELL + x;
      const g = smooth(Math.min(1, v * 1.4)) * 0.85;
      if (g > cell[i]) cell[i] = g;
    }
  }
}

function stampStain(cell, rng) {
  const blobs = 6 + Math.floor(rng() * 6);
  for (let b = 0; b < blobs; b += 1) {
    cellBrush(
      cell,
      40 + rng() * (ATLAS_CELL - 80),
      40 + rng() * (ATLAS_CELL - 80),
      6 + rng() * 16,
      0.35 + rng() * 0.4,
    );
  }
}

/** Build the fixed 2x2 atlas: RGBA, R = shade, A = shape alpha. */
export function buildAtlas() {
  const size = ATLAS_CELL * ATLAS_GRID;
  const data = new Uint8Array(size * size * 4);
  const builders = [stampCrack, stampPatch, stampOil, stampStain];
  for (let s = 0; s < builders.length; s += 1) {
    const rng = splitmix32(ATLAS_SEED ^ (s * 0x9e37));
    const cell = new Float32Array(ATLAS_CELL * ATLAS_CELL);
    builders[s](cell, rng);
    const gx = (s % ATLAS_GRID) * ATLAS_CELL;
    const gz = Math.floor(s / ATLAS_GRID) * ATLAS_CELL;
    for (let z = 0; z < ATLAS_CELL; z += 1) {
      for (let x = 0; x < ATLAS_CELL; x += 1) {
        const v = Math.min(1, cell[z * ATLAS_CELL + x]);
        const o = ((gz + z) * size + gx + x) * 4;
        data[o] = Math.round(40 + 40 * (1 - v)); // shade (dark core)
        data[o + 1] = data[o];
        data[o + 2] = data[o];
        data[o + 3] = Math.round(v * 255);
      }
    }
  }
  return { data, width: size, height: size };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const WEAR_LANE_TYPES = new Set(['driving', 'bidirectional']);
const NOISE_LANE_TYPES = new Set(['shoulder', 'parking', 'biking', 'restricted']);
const BOUNDS_LANE_TYPES = new Set([
  'driving',
  'bidirectional',
  'shoulder',
  'parking',
  'biking',
  'restricted',
  'sidewalk',
  'curb',
]);

// Per-type stamp tint (sRGB 0..255) applied at composite time.
const STAMP_TINT = {
  crack: [22, 22, 24],
  patch: [30, 30, 32],
  oil: [26, 24, 22],
  stain: [52, 52, 56],
};

/**
 * @param {object} opts
 * @param {Array} opts.features  GeoJSON lane_polygon features
 * @param {(lon:number, lat:number) => {x:number, z:number}} opts.project
 * @param {Map<string, number>} opts.laneWidths  rsl -> representative width m
 * @param {number} opts.seed
 * @param {number} [opts.maxSize=4096]  texture size of the longer bounds axis
 * @param {number} [opts.padding=2]     bounds padding in meters
 */
export function generate({ features, project, laneWidths, seed, maxSize = 4096, padding = 2 }) {
  // ---- project + classify lanes ------------------------------------------
  const lanes = [];
  for (const f of features) {
    const p = f.properties ?? {};
    if (p.feature_kind !== 'lane_polygon' || f.geometry?.type !== 'Polygon') continue;
    const laneType = p.LaneType ?? 'none';
    if (!BOUNDS_LANE_TYPES.has(laneType)) continue;
    const ring = f.geometry.coordinates[0].map(([lon, lat]) => {
      const { x, z } = project(lon, lat);
      return [x, z];
    });
    if (ring.length < 4) continue;
    const rsl = `${p.road_id}:${p.section_id}:${p.lane_id}`;
    lanes.push({
      ring,
      bbox: ringBBox(ring),
      area: ringArea(ring),
      laneType,
      isJunction: p.is_junction === true,
      rsl,
    });
  }
  if (lanes.length === 0) throw new Error('no usable lane polygons');

  // ---- bounds + raster allocation -----------------------------------------
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const l of lanes) {
    if (l.bbox.minX < minX) minX = l.bbox.minX;
    if (l.bbox.maxX > maxX) maxX = l.bbox.maxX;
    if (l.bbox.minZ < minZ) minZ = l.bbox.minZ;
    if (l.bbox.maxZ > maxZ) maxZ = l.bbox.maxZ;
  }
  minX -= padding;
  minZ -= padding;
  maxX += padding;
  maxZ += padding;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const scale = maxSize / Math.max(spanX, spanZ); // px per meter
  const width = Math.max(4, Math.round(spanX * scale));
  const height = Math.max(4, Math.round(spanZ * scale));
  const bounds = { minX, minZ, maxX, maxZ };

  const splat = new Uint8Array(width * height * 4);
  const overlay = new Uint8Array(width * height * 4);

  const toPx = (x) => (x - minX) * scale;
  const toPz = (z) => (z - minZ) * scale;
  const pxToX = (px) => minX + (px + 0.5) / scale;
  const pzToZ = (pz) => minZ + (pz + 0.5) / scale;

  const maxByte = (buf, i, v) => {
    const b = Math.round(Math.max(0, Math.min(1, v)) * 255);
    if (b > buf[i]) buf[i] = b;
  };

  // ---- per-lane splat rasterization ---------------------------------------
  for (const lane of lanes) {
    const wear = WEAR_LANE_TYPES.has(lane.laneType);
    const noiseOnly = NOISE_LANE_TYPES.has(lane.laneType);
    if (!wear && !noiseOnly) continue; // sidewalk/curb contribute bounds only

    const widthM = laneWidths.get(lane.rsl);
    const halfW = Math.min(2.5, Math.max(1.0, (widthM ?? 3.2) / 2));
    // Stable per-lane traffic amplitude.
    const laneRng = splitmix32(seed ^ hashString(lane.rsl));
    const amp = 0.55 + laneRng() * 0.45;

    const px0 = Math.max(0, Math.floor(toPx(lane.bbox.minX)));
    const px1 = Math.min(width - 1, Math.ceil(toPx(lane.bbox.maxX)));
    const pz0 = Math.max(0, Math.floor(toPz(lane.bbox.minZ)));
    const pz1 = Math.min(height - 1, Math.ceil(toPz(lane.bbox.maxZ)));
    for (let pz = pz0; pz <= pz1; pz += 1) {
      const z = pzToZ(pz);
      for (let px = px0; px <= px1; px += 1) {
        const x = pxToX(px);
        if (!pointInRing(x, z, lane.ring)) continue;
        const i = (pz * width + px) * 4;

        // Variant weights: continuous world-space noise fields, so blends
        // flow across lane boundaries without seams.
        const aged = smooth(Math.min(1, Math.max(0, (fbm(x, z, 24, seed ^ 0xa11) - 0.48) / 0.24)));
        const repair = smooth(
          Math.min(1, Math.max(0, (fbm(x, z, 31, seed ^ 0xb22) - 0.66) / 0.18)),
        );
        const noiseAmp = noiseOnly ? 0.6 : 1.0;
        maxByte(splat, i, aged * 0.85 * noiseAmp);
        maxByte(splat, i + 1, repair * 0.9 * noiseAmp);

        if (!wear) continue;
        const d = distToRing(x, z, lane.ring);
        const t = Math.min(1, d / halfW);

        // Wheel tracks: twin bands around t=0.55 of the half-width.
        const wheel = Math.exp(-((t - 0.55) ** 2) / (2 * 0.2 ** 2));
        // Center oil band (lane center = max distance from edges).
        const oil = Math.exp(-((t - 1.0) ** 2) / (2 * 0.28 ** 2)) * 0.6;
        const along = 0.55 + 0.45 * fbm(x, z, 9, seed ^ 0xc33);
        maxByte(splat, i + 2, Math.max(wheel, oil) * amp * along);

        // Marking erosion: edge band + wheel-crossing bleed.
        const edge = Math.max(0, 1 - t / 0.22);
        const chipNoise = 0.35 + 0.65 * fbm(x, z, 3, seed ^ 0xd44);
        const erosion = Math.max(edge * chipNoise * amp, wheel * 0.35 * chipNoise);
        maxByte(splat, i + 3, erosion);
      }
    }
  }

  // ---- decal instances -----------------------------------------------------
  const atlas = buildAtlas();
  const decals = [];
  const decalRng = splitmix32(seed ^ 0x5eed);
  const plans = [
    { type: 'crack', stamp: 0, per: 300, size: [2.0, 5.0], intensity: [0.5, 0.9], junction: null },
    { type: 'patch', stamp: 1, per: 460, size: [2.5, 5.5], intensity: [0.6, 0.95], junction: null },
    { type: 'oil', stamp: 2, per: 480, size: [1.4, 2.8], intensity: [0.35, 0.6], junction: true },
    { type: 'stain', stamp: 3, per: 600, size: [0.8, 2.0], intensity: [0.3, 0.55], junction: null },
  ];
  for (const lane of lanes) {
    if (!WEAR_LANE_TYPES.has(lane.laneType)) continue;
    for (const plan of plans) {
      if (plan.junction !== null && plan.junction !== lane.isJunction) continue;
      const expected = lane.area / plan.per;
      let count = Math.floor(expected);
      if (decalRng() < expected - count) count += 1;
      for (let c = 0; c < count; c += 1) {
        const { x, z } = interiorPoint(lane.ring, lane.bbox, decalRng);
        decals.push({
          type: plan.type,
          stamp: plan.stamp,
          x: Math.round(x * 1000) / 1000,
          z: Math.round(z * 1000) / 1000,
          rotDeg: Math.round(decalRng() * 360 * 100) / 100,
          sizeM:
            Math.round((plan.size[0] + decalRng() * (plan.size[1] - plan.size[0])) * 100) / 100,
          intensity:
            Math.round(
              (plan.intensity[0] + decalRng() * (plan.intensity[1] - plan.intensity[0])) * 100,
            ) / 100,
        });
      }
    }
  }

  // ---- composite decals into the overlay (and patches into splat R) -------
  for (const d of decals) {
    const half = d.sizeM / 2;
    const cos = Math.cos((d.rotDeg * Math.PI) / 180);
    const sin = Math.sin((d.rotDeg * Math.PI) / 180);
    const px0 = Math.max(0, Math.floor(toPx(d.x - half * 1.5)));
    const px1 = Math.min(width - 1, Math.ceil(toPx(d.x + half * 1.5)));
    const pz0 = Math.max(0, Math.floor(toPz(d.z - half * 1.5)));
    const pz1 = Math.min(height - 1, Math.ceil(toPz(d.z + half * 1.5)));
    const gx = (d.stamp % ATLAS_GRID) * ATLAS_CELL;
    const gz = Math.floor(d.stamp / ATLAS_GRID) * ATLAS_CELL;
    const tint = STAMP_TINT[d.type];
    for (let pz = pz0; pz <= pz1; pz += 1) {
      const z = pzToZ(pz);
      for (let px = px0; px <= px1; px += 1) {
        const x = pxToX(px);
        // Inverse-rotate into stamp space.
        const lx = (x - d.x) * cos + (z - d.z) * sin;
        const lz = -(x - d.x) * sin + (z - d.z) * cos;
        const u = lx / d.sizeM + 0.5;
        const v = lz / d.sizeM + 0.5;
        if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
        const ax = gx + Math.min(ATLAS_CELL - 1, Math.floor(u * ATLAS_CELL));
        const az = gz + Math.min(ATLAS_CELL - 1, Math.floor(v * ATLAS_CELL));
        const ao = (az * atlas.width + ax) * 4;
        const alpha = (atlas.data[ao + 3] / 255) * d.intensity;
        if (alpha <= 0.004) continue;
        const shade = atlas.data[ao] / 255;
        const i = (pz * width + px) * 4;
        const prev = overlay[i + 3] / 255;
        if (alpha > prev) {
          overlay[i] = Math.round(tint[0] * (0.7 + 0.3 * shade));
          overlay[i + 1] = Math.round(tint[1] * (0.7 + 0.3 * shade));
          overlay[i + 2] = Math.round(tint[2] * (0.7 + 0.3 * shade));
          overlay[i + 3] = Math.round(alpha * 255);
        }
        // Repair patches also force the variant A weight inside the outline.
        if (d.type === 'patch') {
          const inner = Math.max(Math.abs(lx), Math.abs(lz)) < half * 0.82 ? 0.95 : 0;
          if (inner > 0) maxByte(splat, i, inner);
        }
      }
    }
  }

  return {
    bounds,
    width,
    height,
    splat,
    overlay,
    atlas,
    decals,
    laneCount: lanes.length,
  };
}
