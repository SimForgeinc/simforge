self.onmessage = ({ data }) => {
  if (data.kind !== 'run') return;
  run(data).catch((error) => self.postMessage({ kind: 'error', message: error?.stack || String(error) }));
};

async function run({ actors, moduleUrl, networkUrl }) {
  const importedAt = performance.now();
  const [{ default: createSumo }, networkResponse] = await Promise.all([
    import(moduleUrl),
    fetch(networkUrl),
  ]);
  const network = new Uint8Array(await networkResponse.arrayBuffer());
  const sumo = await createSumo({ noInitialRun: true });
  const factoryMilliseconds = performance.now() - importedAt;
  const routes = new TextEncoder().encode(routeDocument(actors));
  const netPointer = copy(sumo, network);
  const routePointer = copy(sumo, routes);
  const startAt = performance.now();
  assertOk(sumo, sumo._us_sumo_start(netPointer, network.byteLength, routePointer, routes.byteLength, 0.1, 1));
  const startMilliseconds = performance.now() - startAt;
  sumo._free(netPointer);
  sumo._free(routePointer);

  self.postMessage({ kind: 'progress', message: `Warming ${actors} requested actors…` });
  for (let index = 0; index < 450; index += 1) assertOk(sumo, sumo._us_sumo_step(0.1));

  const workerSteps = [];
  const transferCopies = [];
  let actualActors = 0;
  for (let index = 0; index < 200; index += 1) {
    const beforeStep = performance.now();
    assertOk(sumo, sumo._us_sumo_step(0.1));
    workerSteps.push(performance.now() - beforeStep);
    actualActors = sumo._us_sumo_state_count();
    const beforeCopy = performance.now();
    const state = new Uint8Array(
      sumo.HEAPU8.buffer,
      sumo._us_sumo_state_pointer(),
      actualActors * 32,
    ).slice().buffer;
    transferCopies.push(performance.now() - beforeCopy);
    // Exercise the real transferable path. The main thread intentionally does
    // not deserialize per-actor objects.
    if (index % 5 === 0) self.postMessage({ kind: 'state', state }, [state]);
  }
  sumo._us_sumo_close();
  self.postMessage({
    kind: 'result',
    report: {
      requestedActors: actors,
      actualActors,
      factoryMilliseconds,
      startMilliseconds,
      heapBytes: sumo.HEAPU8.buffer.byteLength,
      workerStepP50Milliseconds: percentile(workerSteps, 0.5),
      workerStepP95Milliseconds: percentile(workerSteps, 0.95),
      workerStepP99Milliseconds: percentile(workerSteps, 0.99),
      transferCopyP95Milliseconds: percentile(transferCopies, 0.95),
    },
  });
}

function copy(sumo, bytes) {
  const pointer = sumo._malloc(bytes.byteLength);
  sumo.HEAPU8.set(bytes, pointer);
  return pointer;
}

function assertOk(sumo, code) {
  if (code === 0) return;
  throw new Error(sumo.UTF8ToString(sumo._us_sumo_last_error()) || `SUMO failed (${code})`);
}

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function routeDocument(count) {
  const pairs = [];
  for (let row = 0; row < 5; row += 1) {
    pairs.push([`left${row}A${row}`, `E${row}right${row}`]);
    pairs.push([`right${row}E${row}`, `A${row}left${row}`]);
  }
  const base = Math.floor(count / pairs.length);
  let remainder = count % pairs.length;
  const flows = pairs.map(([from, to], index) => {
    const number = base + (remainder-- > 0 ? 1 : 0);
    return `<flow id="flow-${index}" type="browserCar" begin="0" end="40" number="${number}" from="${from}" to="${to}" departLane="best" departSpeed="max"/>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><routes><vType id="browserCar" carFollowModel="EIDM" laneChangeModel="SL2015" accel="2.6" decel="4.5" sigma="0.4" tau="1.0"/>${flows}</routes>`;
}
