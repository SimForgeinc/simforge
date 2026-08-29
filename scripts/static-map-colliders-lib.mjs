import { sha256 } from './map-derivatives-lib.mjs';

export const STATIC_COLLIDER_SCHEMA = 'simforge-oss.static-map-colliders/v1';

const SOLID_CATEGORIES = new Set(['building']);
const TRAVEL_LANE_TYPES = new Set(['driving', 'biking', 'parking', 'shoulder']);
const ROAD_INDEX_CELL_M = 20;
const COLLIDER_CLASSES = ['building', 'wall', 'barrier', 'prop', 'road-boundary'];

/** Extract deterministic scene-frame OBBs from glTF metadata without decoding triangles. */
export function extractGlbColliders(buffer, tileId) {
  const json = readGlbJson(buffer, tileId);
  const nodes = json.nodes ?? [];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, index) => index);
  const colliders = [];
  let ignored = 0;
  const visit = (index, parent) => {
    const node = nodes[index];
    if (!node) return;
    const world = multiply4(parent, nodeMatrix(node));
    const collisionClass = classifyNode(node);
    const bounds = node.mesh === undefined ? null : meshBounds(json, node.mesh);
    if (collisionClass && bounds) {
      const obb = projectedObb(bounds, world);
      if (obb.lengthM >= 0.08 && obb.widthM >= 0.08 && Number.isFinite(obb.center.x + obb.center.z)) {
        colliders.push({ id: `${tileId}/${index}`, class: collisionClass, obb });
      } else ignored += 1;
    } else if (node.mesh !== undefined) ignored += 1;
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const root of roots) visit(root, IDENTITY);
  return { colliders, ignored };
}

/** Build the compact, timestamp-free artifact published with a map bundle. */
export function buildStaticColliderArtifact({ mapId, sourceManifestSha256, manifest, topology, readSource }) {
  if (!Array.isArray(manifest.tiles)) throw new Error('Static collision manifest has no tile list');
  const selected = manifest.tiles.map((tile, index) => {
    const lod = [...(tile.lods ?? [])].sort((a, b) => b.level - a.level || a.file.localeCompare(b.file))[0];
    if (!lod) throw new Error(`Static collision tile ${tile.id ?? index} has no LOD`);
    return { id: tile.id ?? `tile-${index}`, file: lod.file, declaredBytes: lod.fileSize ?? null };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const classes = Object.fromEntries(COLLIDER_CLASSES.map((name) => [name, 0]));
  const travelLaneIndex = buildTravelLaneIndex(topology);
  const colliders = [];
  let rejectedRoadOverlap = 0;
  let ignored = 0;
  const sources = [];
  for (const tile of selected) {
    const bytes = readSource(tile.file);
    sources.push({ id: tile.id, file: tile.file, declaredBytes: tile.declaredBytes });
    const extracted = extractGlbColliders(bytes, tile.id);
    ignored += extracted.ignored;
    for (const collider of extracted.colliders) {
      // Explicit curbs/guardrails define the road boundary and are expected to
      // touch the lane envelope. All broader semantic classes remain subject
      // to the conservative travel-lane rejection gate.
      if (collider.class !== 'road-boundary' && overlapsTravelLane(collider, travelLaneIndex)) {
        rejectedRoadOverlap += 1;
        continue;
      }
      classes[collider.class] += 1;
      colliders.push(collider);
    }
  }
  colliders.sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    schema: STATIC_COLLIDER_SCHEMA,
    mapId,
    sourceManifestSha256,
    sources,
    colliders,
    statistics: {
      sourceTiles: selected.length,
      accepted: colliders.length,
      rejectedRoadOverlap,
      ignored,
      classes,
    },
  };
  return { ...payload, digest: `sha256-${sha256(Buffer.from(JSON.stringify(payload)))}` };
}

export function serializeStaticColliderArtifact(artifact) {
  return `${JSON.stringify(artifact)}\n`;
}

function readGlbJson(buffer, tileId) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67 || buffer.readUInt32LE(4) !== 2) {
    throw new Error(`Static collision tile ${tileId} is not GLB v2`);
  }
  const jsonLength = buffer.readUInt32LE(12);
  if (jsonLength <= 0 || 20 + jsonLength > buffer.length || buffer.readUInt32LE(16) !== 0x4e4f534a) {
    throw new Error(`Static collision tile ${tileId} has no valid JSON chunk`);
  }
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').replace(/[\0 ]+$/, ''));
}

function classifyNode(node) {
  const category = node.extras?.category?.toLowerCase() ?? '';
  const name = node.name?.toLowerCase() ?? '';
  const explicitBoundary = /(?:^|[_ -])(curb|kerb|guardrail|road[_ -]?edge)(?:$|[_ -])/.test(name);
  if (explicitBoundary) return 'road-boundary';
  if (!SOLID_CATEGORIES.has(category) && !/building|fence|wall|barrier|bollard|border|guardrail/.test(name)) return null;
  if (/fence|wall/.test(name)) return 'wall';
  if (/barrier|bollard|border/.test(name)) return 'barrier';
  return category === 'building' || /building/.test(name) ? 'building' : 'prop';
}

function meshBounds(json, meshIndex) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const primitive of json.meshes?.[meshIndex]?.primitives ?? []) {
    const position = primitive.attributes?.POSITION;
    const accessor = position === undefined ? undefined : json.accessors?.[position];
    if (!accessor?.min || !accessor.max || accessor.min.length < 3 || accessor.max.length < 3) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], normalizedAccessorValue(accessor, accessor.min[axis]));
      max[axis] = Math.max(max[axis], normalizedAccessorValue(accessor, accessor.max[axis]));
    }
    found = true;
  }
  return found ? { min, max } : null;
}

function normalizedAccessorValue(accessor, value) {
  if (!accessor.normalized) return value;
  switch (accessor.componentType) {
    case 5120: return Math.max(value / 127, -1);
    case 5121: return value / 255;
    case 5122: return Math.max(value / 32767, -1);
    case 5123: return value / 65535;
    default: return value;
  }
}

function projectedObb(bounds, matrix) {
  const centerLocal = bounds.min.map((value, index) => (value + bounds.max[index]) / 2);
  const center3 = transformPoint(matrix, centerLocal);
  const basis = transformVector(matrix, [1, 0, 0]);
  const headingRad = Math.atan2(-basis[2], basis[0]);
  const forward = [Math.cos(headingRad), -Math.sin(headingRad)];
  const left = [-forward[1], forward[0]];
  let halfLength = 0;
  let halfWidth = 0;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) {
      const point = transformPoint(matrix, [x, y, z]);
      const dx = point[0] - center3[0];
      const dz = -(point[2] - center3[2]);
      halfLength = Math.max(halfLength, Math.abs(dx * forward[0] + dz * forward[1]));
      halfWidth = Math.max(halfWidth, Math.abs(dx * left[0] + dz * left[1]));
    }
  }
  return { center: { x: center3[0], z: -center3[2] }, lengthM: halfLength * 2, widthM: halfWidth * 2, headingRad };
}

function buildTravelLaneIndex(topology) {
  const buckets = new Map();
  for (const lane of Object.values(topology.lanes ?? {})) {
    if (!TRAVEL_LANE_TYPES.has(lane.laneType)) continue;
    const clearance = Math.max(1, (lane.representativeWidthM ?? 3.5) / 2 + 0.75);
    for (const point of lane.polyline ?? []) {
      const x = Array.isArray(point) ? point[0] : point.x;
      const z = -(Array.isArray(point) ? point[1] : point.y);
      const key = `${Math.floor(x / ROAD_INDEX_CELL_M)},${Math.floor(z / ROAD_INDEX_CELL_M)}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push({ x, z, clearance });
      buckets.set(key, bucket);
    }
  }
  return { buckets, populatedCells: [...buckets.keys()].map((key) => key.split(',').map(Number)) };
}

function overlapsTravelLane(collider, index) {
  const { obb } = collider;
  const cos = Math.cos(obb.headingRad);
  const sin = Math.sin(obb.headingRad);
  const radius = Math.hypot(obb.lengthM, obb.widthM) / 2 + 3;
  const x0 = Math.floor((obb.center.x - radius) / ROAD_INDEX_CELL_M);
  const x1 = Math.floor((obb.center.x + radius) / ROAD_INDEX_CELL_M);
  const z0 = Math.floor((obb.center.z - radius) / ROAD_INDEX_CELL_M);
  const z1 = Math.floor((obb.center.z + radius) / ROAD_INDEX_CELL_M);
  const gridArea = (x1 - x0 + 1) * (z1 - z0 + 1);
  const cells = gridArea <= 4096
    ? function* boundedCells() { for (let gx = x0; gx <= x1; gx += 1) for (let gz = z0; gz <= z1; gz += 1) yield [gx, gz]; }()
    : index.populatedCells.filter(([gx, gz]) => gx >= x0 && gx <= x1 && gz >= z0 && gz <= z1);
  for (const [gx, gz] of cells) {
    for (const sample of index.buckets.get(`${gx},${gz}`) ?? []) {
      const dx = sample.x - obb.center.x;
      const dz = sample.z - obb.center.z;
      if (Math.abs(dx * cos + dz * sin) <= obb.lengthM / 2 + sample.clearance
        && Math.abs(-dx * sin + dz * cos) <= obb.widthM / 2 + sample.clearance) return true;
    }
  }
  return false;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function nodeMatrix(node) {
  if (node.matrix?.length === 16) return [...node.matrix];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  }
  return out;
}

function transformPoint(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

function transformVector(matrix, point) {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2],
  ];
}
