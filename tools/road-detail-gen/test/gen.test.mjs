import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { generate, buildAtlas, splitmix32, valueNoise } from '../src/gen.mjs';
import { encodePngRgba } from '../src/png.mjs';
import { makeProjector, parseGeoReference } from '../src/geo.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Synthetic straight road: two driving lanes + a shoulder, meters in/out. */
function fixture() {
  const rect = (x0, z0, x1, z1) => [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ];
  const lane = (ring, laneType, laneId, junction = false) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: {
      feature_kind: 'lane_polygon',
      LaneType: laneType,
      road_id: '7',
      section_id: 0,
      lane_id: laneId,
      is_junction: junction,
    },
  });
  return {
    features: [
      lane(rect(0, 0, 120, 3.5), 'driving', -1),
      lane(rect(0, 3.5, 120, 7.0), 'driving', 1),
      lane(rect(0, 7.0, 120, 8.2), 'shoulder', 2),
      lane(rect(0, -1.8, 120, 0), 'sidewalk', 3),
    ],
    // Features are already in meters; identity projection with z flip
    // matching the bundle convention.
    project: (x, y) => ({ x, z: -y }),
    laneWidths: new Map([
      ['7:0:-1', 3.5],
      ['7:0:1', 3.5],
      ['7:0:2', 1.2],
    ]),
  };
}

test('generation is deterministic for a fixed seed and pinned digest', () => {
  const a = generate({ ...fixture(), seed: 42, maxSize: 256 });
  const b = generate({ ...fixture(), seed: 42, maxSize: 256 });
  assert.equal(sha256(a.splat), '64e943022025a16a6440956d0a70f2909dcbe005bce945f9e2bb92c51abb3ec8');
  assert.equal(sha256(a.overlay), 'd8fa5d0d9071baa0879f8238c6011d3f08fd4631e7ea8410da536f01153d7380');
  assert.equal(sha256(a.splat), sha256(b.splat));
  assert.equal(sha256(a.overlay), sha256(b.overlay));
  assert.deepEqual(a.decals, b.decals);
  assert.deepEqual(a.bounds, b.bounds);
});

test('different seeds change the masks', () => {
  const a = generate({ ...fixture(), seed: 42, maxSize: 256 });
  const b = generate({ ...fixture(), seed: 43, maxSize: 256 });
  assert.notEqual(sha256(a.splat), sha256(b.splat));
});

test('wear bands land inside driving lanes only', () => {
  const r = generate({ ...fixture(), seed: 7, maxSize: 512 });
  const { width, height, bounds, splat } = r;
  const scale = width / (bounds.maxX - bounds.minX);
  const px = (x) => Math.floor((x - bounds.minX) * scale);
  const pz = (z) => Math.floor((z - bounds.minZ) * scale);
  // Wheel-track band: ~0.96 m from the lane edge (t=0.55 of half-width) of
  // the z=[-3.5,0] driving lane. Scan its row for wear energy.
  let inLane = 0;
  for (let x = 10; x < 110; x += 1) {
    inLane = Math.max(inLane, splat[(pz(-0.96) * width + px(x)) * 4 + 2]);
  }
  assert.ok(inLane > 100, `expected strong wheel wear inside lane, got ${inLane}`);
  // Sidewalk (z in [0, 1.8]) must carry no wear.
  let inSidewalk = 0;
  for (let x = 10; x < 110; x += 1) {
    inSidewalk = Math.max(inSidewalk, splat[(pz(0.9) * width + px(x)) * 4 + 2]);
  }
  assert.equal(inSidewalk, 0);
});

test('marking erosion concentrates at lane edges', () => {
  const r = generate({ ...fixture(), seed: 7, maxSize: 512 });
  const { width, bounds, splat } = r;
  const scale = width / (bounds.maxX - bounds.minX);
  const px = (x) => Math.floor((x - bounds.minX) * scale);
  const pz = (z) => Math.floor((z - bounds.minZ) * scale);
  let edge = 0;
  let center = 0;
  for (let x = 10; x < 110; x += 1) {
    edge += splat[(pz(-0.2) * width + px(x)) * 4 + 3]; // lane-edge band
    center += splat[(pz(-1.75) * width + px(x)) * 4 + 3]; // lane center
  }
  assert.ok(edge > center, `edge erosion ${edge} should exceed center ${center}`);
});

test('atlas is stable, pinned, and carries all four stamps', () => {
  const a = buildAtlas();
  const b = buildAtlas();
  assert.equal(sha256(a.data), 'ef4c606dda5855d2acb3433382dc4120d2f7d48cc5fb2165e6cc6fe56ca43f4a');
  assert.equal(sha256(a.data), sha256(b.data));
  assert.equal(a.width, 512);
  // Every 256px cell must contain non-empty alpha.
  for (let s = 0; s < 4; s += 1) {
    const gx = (s % 2) * 256;
    const gz = Math.floor(s / 2) * 256;
    let energy = 0;
    for (let z = 0; z < 256; z += 8) {
      for (let x = 0; x < 256; x += 8) {
        energy += a.data[((gz + z) * a.width + gx + x) * 4 + 3];
      }
    }
    assert.ok(energy > 0, `stamp ${s} is empty`);
  }
});

test('rng and noise are stable across calls', () => {
  const r1 = splitmix32(123);
  const r2 = splitmix32(123);
  for (let i = 0; i < 100; i += 1) assert.equal(r1(), r2());
  assert.equal(valueNoise(12.3, -4.5, 7, 99), valueNoise(12.3, -4.5, 7, 99));
});

test('png encoder emits a valid signature and IHDR', () => {
  const rgba = Buffer.alloc(8 * 4 * 4, 0x80);
  const png = encodePngRgba(rgba, 8, 4);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 8); // width
  assert.equal(png.readUInt32BE(20), 4); // height
  assert.throws(() => encodePngRgba(rgba, 9, 4));
});

test('georeference parsing and projection match the bundle convention', () => {
  const xodr = `<header><geoReference><![CDATA[+proj=tmerc +lat_0=37.3062949404212 +lon_0=-121.987040676177 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +vunits=m +no_defs]]></geoReference></header>`;
  const origin = parseGeoReference(xodr);
  assert.ok(Math.abs(origin.lat0 - 37.3062949404212) < 1e-12);
  const project = makeProjector(origin);
  const at = project(origin.lon0, origin.lat0);
  assert.ok(Math.abs(at.x) < 1e-9 && Math.abs(at.z) < 1e-9);
  // +0.001 deg lon at 37.3N ~ 88.5 m east; +lat moves -z (sf.z = -local_y).
  const east = project(origin.lon0 + 0.001, origin.lat0);
  assert.ok(Math.abs(east.x - 88.5) < 0.5, `east ${east.x}`);
  const north = project(origin.lon0, origin.lat0 + 0.001);
  assert.ok(north.z < -110 && north.z > -111.5, `north z ${north.z}`);
});
