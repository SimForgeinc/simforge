import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [modulePath, networkPath] = process.argv.slice(2);
if (!modulePath || !networkPath) {
  console.error('usage: node proxy-smoke.mjs <sumo.mjs> <four-lane-grid.net.xml>');
  process.exit(2);
}

const network = await readFile(networkPath);
const laneShape = network.toString('utf8').match(/<lane id="A2B2_0"[^>]*shape="([^"]+)"/i)?.[1];
const proxyY = Number(laneShape?.split(' ')[0]?.split(',')[1]);
if (!Number.isFinite(proxyY)) throw new Error('fixture does not contain lane A2B2_0');
const routes = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<routes>
  <vType id="ambient" carFollowModel="EIDM" accel="2.6" decel="4.5" tau="1.0"/>
  <route id="west-east" edges="left2A2 A2B2 B2C2 C2D2 D2E2 E2right2"/>
  <flow id="ambient-flow" type="ambient" route="west-east" begin="0" end="5" number="10" departLane="best" departSpeed="max"/>
</routes>`);
const { default: createSumo } = await import(pathToFileURL(modulePath));
const sumo = await createSumo({ noInitialRun: true });

const baseline = run(false);
const blocked = run(true);
if (blocked.stoppedActors < 1) throw new Error('stopped proxy did not create a following queue');
if (blocked.leadingX >= baseline.leadingX - 25) {
  throw new Error(`proxy did not materially constrain traffic (${blocked.leadingX} vs ${baseline.leadingX})`);
}
console.log(JSON.stringify({ baseline, blocked, proxyReaction: 'pass' }, null, 2));

function run(withProxy) {
  const networkPointer = copy(network);
  const routesPointer = copy(routes);
  assertOk(sumo._us_sumo_start(networkPointer, network.byteLength, routesPointer, routes.byteLength, 0.1, 7));
  sumo._free(networkPointer);
  sumo._free(routesPointer);

  const id = makeString('authored-obstacle');
  const route = makeString('west-east');
  for (let step = 0; step < 600; step += 1) {
    if (withProxy) assertOk(sumo._us_sumo_upsert_external(id.pointer, 3, route.pointer, 400, proxyY, 90, 0, 4.5, 2));
    assertOk(sumo._us_sumo_step(0.1));
  }
  const view = new DataView(sumo.HEAPU8.buffer, sumo._us_sumo_state_pointer(), sumo._us_sumo_state_count() * 32);
  let leadingX = Number.NEGATIVE_INFINITY;
  let stoppedActors = 0;
  for (let offset = 0; offset < view.byteLength; offset += 32) {
    leadingX = Math.max(leadingX, view.getFloat32(offset + 4, true));
    if (view.getFloat32(offset + 16, true) < 0.25) stoppedActors += 1;
  }
  id.free();
  route.free();
  const actorCount = sumo._us_sumo_state_count();
  sumo._us_sumo_close();
  return { actorCount, leadingX, stoppedActors };
}

function copy(bytes) {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return pointer;
}

function makeString(value) {
  const size = sumo.lengthBytesUTF8(value) + 1;
  const pointer = sumo._malloc(size);
  sumo.stringToUTF8(value, pointer, size);
  return { pointer, free: () => sumo._free(pointer) };
}

function assertOk(code) {
  if (code === 0) return;
  throw new Error(sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}
