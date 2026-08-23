#!/usr/bin/env node
/**
 * V2X trajectory JSON → UniScenarios v2 template converter.
 *
 * Ports the authoring format of V2XCarla's `digital_twin_bridge/trajectory_player.py`
 * (READ-ONLY source): both accepted input shapes are handled identically —
 *
 *   1. V2X detection list:  [{object_id, object_type?, timestamp_utc,
 *                             gps_location: {latitude, longitude}}, ...]
 *      The most-frequent object_id wins (single-actor playback), records sort
 *      by timestamp, ISO-8601 timestamps normalise to seconds from the first.
 *   2. Simple waypoint list: [{t, lat, lon}, ...] — t seconds since start.
 *
 * GPS → local metres uses the legacy flat-earth contract pinned by
 * docs/v2x-coordinate-contract.md (V2XMapParity): equirectangular around the
 * XODR georeference natural origin, read straight from the map's own
 * `<geoReference>` and digest-pinned into the emitted template per the
 * {mapId, xodrSha256} rule. Scene frame: x = easting, z = −northing (= CARLA y).
 *
 * The output is a map-bound v2 template whose actor follows a
 * `customTimedRoute` (exact scene-space keyframes, time owns motion) — the
 * deterministic counterpart of trajectory_player's pure-pursuit/PID playback.
 *
 * Usage:
 *   node apps/v2x-migration/tools/trajectory-to-template.mjs <trajectory.json> \
 *     --map richmond-field-station --out <template.json> [--object-id ID]
 *     [--actor-id ID] [--class car] [--catalog-id vehicle.sedan] [--pad-s 5]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { gunzipSync } from 'node:zlib';

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const input = args[0];
if (!input || !flag('out')) {
  console.error('usage: trajectory-to-template.mjs <trajectory.json> --map <id> --out <template.json> [--object-id ID] [--actor-id ID] [--class car] [--catalog-id vehicle.sedan] [--pad-s 5]');
  process.exit(1);
}
const MAP_ID = flag('map') ?? 'richmond-field-station';
const OUT = flag('out');
const FILTER_OBJECT_ID = flag('object-id');
const ACTOR_ID = flag('actor-id') ?? 'trajectory_vehicle';
const ACTOR_CLASS = flag('class') ?? 'car';
const CATALOG_ID = flag('catalog-id');
const PAD_S = Number(flag('pad-s') ?? 5);

// ── Map identity + georef (digest-pinned) ────────────────────────────────────
const mapDir = `dev-assets/${MAP_ID}`;
const bundle = JSON.parse(readFileSync(`${mapDir}/bundle.json`, 'utf8'));
const xodrSha256 = bundle.xodrSha256;
if (!xodrSha256) throw new Error(`bundle.json for ${MAP_ID} carries no xodrSha256`);

const xodrHead = readFileSync(`${mapDir}/xodr.xodr`, { encoding: 'utf8', flag: 'r' }).slice(0, 262_144);
const geoMatch = xodrHead.match(/<geo[Rr]eference[^>]*><!\[CDATA\[([^\]]*)\]\]>/i)
  ?? xodrHead.match(/<geo[Rr]eference[^>]*>([^<]*)</i);
if (!geoMatch) throw new Error(`no <geoReference> in first 256 KiB of ${mapDir}/xodr.xodr`);
const proj = geoMatch[1].replaceAll('&amp;', '&').replaceAll('&quot;', '"');
const param = (name) => {
  const m = proj.match(new RegExp(`\\+${name}=([+-]?[0-9.eE+]+)`));
  return m ? Number(m[1]) : null;
};
const lat0 = param('lat_0');
const lon0 = param('lon_0');
if (lat0 === null || lon0 === null) throw new Error(`georeference lacks +lat_0/+lon_0: ${proj}`);

const METERS_PER_DEG_LAT = 111320.0;
const metersPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
function wgs84ToScene(lat, lon) {
  // docs/v2x-coordinate-contract.md — legacy flat-earth frame; scene.z is the
  // negated northing, numerically identical to the legacy CARLA y.
  return {
    x: (lon - lon0) * metersPerDegLon,
    z: -((lat - lat0) * METERS_PER_DEG_LAT),
  };
}

// ── Trajectory parsing (ports trajectory_player.py) ─────────────────────────
const raw = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(raw) || raw.length === 0) throw new Error('Trajectory JSON must be a non-empty list');

const isoSeconds = (s) => Date.parse(s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`) / 1000;

let points;
let objectType = 'car';
let selectedObjectId = null;
if ('gps_location' in raw[0] || 'timestamp_utc' in raw[0]) {
  // V2X detection list: most-frequent object_id, sorted by timestamp.
  const counts = new Map();
  for (const r of raw) counts.set(r.object_id ?? '?', (counts.get(r.object_id ?? '?') ?? 0) + 1);
  const target = FILTER_OBJECT_ID ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  selectedObjectId = target;
  const records = raw.filter((r) => r.object_id === target && r.gps_location && r.timestamp_utc);
  records.sort((a, b) => String(a.timestamp_utc).localeCompare(String(b.timestamp_utc)));
  if (records.length < 2) throw new Error(`Trajectory needs ≥2 waypoints for object ${target}, got ${records.length}`);
  const t0 = isoSeconds(records[0].timestamp_utc);
  points = records.map((r) => ({
    t: isoSeconds(r.timestamp_utc) - t0,
    ...wgs84ToScene(r.gps_location.latitude, r.gps_location.longitude),
    lat: r.gps_location.latitude,
    lon: r.gps_location.longitude,
  }));
  objectType = records[0].object_type ?? 'car';
} else if ('lat' in raw[0] && 'lon' in raw[0]) {
  points = raw
    .filter((r) => Number.isFinite(Number(r.t)) && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lon)))
    .map((r) => ({ t: Number(r.t), ...wgs84ToScene(Number(r.lat), Number(r.lon)), lat: Number(r.lat), lon: Number(r.lon) }))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error(`Trajectory needs ≥2 valid waypoints, got ${points.length}`);
  const t0 = points[0].t;
  for (const p of points) p.t -= t0;
} else {
  throw new Error('Unrecognised trajectory format');
}

const durationS = points[points.length - 1].t - points[0].t;

// Snap samples to the map's lane-centre polylines — the deterministic
// counterpart of trajectory_player.py's `get_waypoint(project_to_road)` snap.
// Perception-derived GPS tracks carry metre-level lateral jitter; snapping
// removes it so the authored keyframes describe the driven lane, not the noise.
if (!flag('no-snap')) {
  const topology = JSON.parse(gunzipSync(readFileSync(`${mapDir}/topology-index.json.gz`)));
  const lanesScene = [];
  for (const lane of Object.values(topology.lanes)) {
    if (!Array.isArray(lane.polyline) || lane.polyline.length < 2) continue;
    // xodr-local (x, y north) → scene (x, −y).
    lanesScene.push(lane.polyline.map((p) => [p.x, -p.y]));
  }
  const snap = ([px, pz]) => {
    let best = null;
    for (const poly of lanesScene) {
      for (let i = 1; i < poly.length; i++) {
        const [ax, az] = poly[i - 1];
        const [bx, bz] = poly[i];
        const dx = bx - ax;
        const dz = bz - az;
        const L2 = dx * dx + dz * dz || 1e-9;
        const u = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
        const cx = ax + u * dx;
        const cz = az + u * dz;
        const d = (px - cx) ** 2 + (pz - cz) ** 2;
        if (best === null || d < best.d) best = { d, x: cx, z: cz };
      }
    }
    return [best.x, best.z];
  };
  points = points.map((p) => {
    const [sx, sz] = snap([p.x, p.z]);
    return { ...p, x: sx, z: sz };
  });
}

// Resample uniformly in time: the engine walks customTimedRoute keyframes with
// Hermite (Catmull-Rom) tangents, and sparse irregular samples let corners bow.
// Linear resampling keeps the walk timestamp-faithful and tight to the track.
const RESAMPLE_S = Number(flag('resample-s') ?? 0.25);
if (RESAMPLE_S > 0 && points.length > 2) {
  const tEnd = points[points.length - 1].t;
  const resampled = [];
  for (let t = 0; t <= tEnd + 1e-9; t += RESAMPLE_S) {
    let i = 0;
    while (i < points.length - 2 && points[i + 1].t < t) i++;
    const a = points[i];
    const b = points[i + 1];
    const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
    resampled.push({
      t,
      x: a.x + (b.x - a.x) * u,
      z: a.z + (b.z - a.z) * u,
      lat: a.lat + (b.lat - a.lat) * u,
      lon: a.lon + (b.lon - a.lon) * u,
    });
  }
  if (resampled.length >= 2 && resampled.length <= 1024) {
    points = resampled;
  }
}


// ── Template emission ────────────────────────────────────────────────────────
const now = '2026-08-23T00:00:00.000Z';
const template = {
  scenarioVersion: 2,
  meta: {
    name: `GPS trajectory playback — ${basename(input)}${selectedObjectId ? ` (${selectedObjectId})` : ''}`,
    description: `V2XCarla trajectory JSON converted to a timed-route actor on ${MAP_ID}. The vehicle walks the recorded WGS-84 samples as exact scene-space keyframes (customTimedRoute): time owns motion between samples, reproducing trajectory_player.py's timestamp-faithful playback without pure-pursuit drift.`,
    createdAt: now,
    modifiedAt: now,
    appVersion: 'uniscenarios/0.0.1',
    tags: ['v2x-migration', 'trajectory-playback'],
    author: 'v2x-scenario-migration',
    negativeControl: false,
  },
  sourceMap: { mapId: MAP_ID, mapName: MAP_ID },
  params: { declarations: [], constraints: [] },
  environment: { weather: 'clear', timeOfDay: 'noon' },
  anchor: {
    id: `trajectory-${ACTOR_ID}`,
    features: [],
    policy: { allowMirror: false, maxSitesPerMap: 1, diversity: 'off', minScore: 0 },
    pin: { mapId: MAP_ID },
  },
  roles: [
    {
      id: ACTOR_ID,
      actor: {
        class: ACTOR_CLASS === objectType ? ACTOR_CLASS : ACTOR_CLASS,
        ...(CATALOG_ID ? { catalogId: CATALOG_ID } : {}),
        static: false,
        sensors: [],
      },
      label: `recorded GPS track, ${points.length} samples over ${durationS.toFixed(1)} s`,
      initialSpeedKph: 0,
      essentiality: 'required',
      kind: 'scene_absolute',
      pose: { position: { x: points[0].x, y: 0, z: points[0].z }, headingRad: 0 },
    },
  ],
  props: [],
  trafficControls: [],
  mapSignalPlans: [],
  choreography: {
    clipSeconds: Math.ceil(durationS + PAD_S),
    warmupSeconds: 0,
    interactions: [
      {
        id: `${ACTOR_ID}-timed-route`,
        label: 'recorded timestamps drive the walk between keyframes',
        actor: ACTOR_ID,
        verb: 'route',
        trigger: { kind: 'at', t: 0 },
        target: {
          mode: 'customTimedRoute',
          points: points.map((p) => ({ timeS: Number(p.t.toFixed(3)), x: Number(p.x.toFixed(3)), z: Number(p.z.toFixed(3)) })),
        },
      },
    ],
  },
  perception: { mapDivergences: [] },
  invariants: [],
  variants: [],
  metricSubject: ACTOR_ID,
  reasoningTrace: [],
  extensions: {
    v2xMigration: {
      version: 1,
      kind: 'trajectory-json',
      source: {
        fileName: basename(input),
        sha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
        format: selectedObjectId === null ? 'simple-t-lat-lon' : 'v2x-detection-list',
        ...(selectedObjectId !== null
          ? { objectId: selectedObjectId, totalRecords: raw.length, objectRecords: points.length }
          : {}),
      },
      coordinateContract: {
        doc: 'docs/v2x-coordinate-contract.md',
        frame: 'legacy-flat-earth (equirectangular around the XODR natural origin); scene.z = negated northing',
        originLat0: lat0,
        originLon0: lon0,
        metersPerDegLat: METERS_PER_DEG_LAT,
        metersPerDegLon,
        mapId: MAP_ID,
        xodrSha256,
      },
    },
  },
};

writeFileSync(OUT, `${JSON.stringify(template, null, 2)}\n`);


const xs = points.map((p) => p.x);
const zs = points.map((p) => p.z);
const summary = {
  out: OUT,
  samples: points.length,
  durationS: +durationS.toFixed(3),
  bboxScene: { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) },
  start: { lat: points[0].lat, lon: points[0].lon, x: +points[0].x.toFixed(3), z: +points[0].z.toFixed(3) },
  end: {
    lat: points[points.length - 1].lat,
    lon: points[points.length - 1].lon,
    x: +points[points.length - 1].x.toFixed(3),
    z: +points[points.length - 1].z.toFixed(3),
  },
  clipSeconds: template.choreography.clipSeconds,
  mapId: MAP_ID,
  xodrSha256,
};
console.log(JSON.stringify(summary, null, 1));
