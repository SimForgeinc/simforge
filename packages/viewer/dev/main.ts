/**
 * Fixed-pose harness for before/after screenshots of a map's web tier.
 *
 *   pnpm --filter @simforge-oss/viewer dev            # vite on :5177
 *   node packages/viewer/dev/serve.mjs <mapsRoot> 8787 # static maps + basis/
 *   http://localhost:5177/?manifest=http://localhost:8787/el-camino-road/3d/manifest.json
 *
 * `window.__simforge` exposes the viewer, `goto(eye, target)`, `ready()`
 * (resolves when nothing is loading, queued or uploading for a few frames)
 * and `stats()` (viewer stats + the shared KTX2 cache counters).
 */
import { CityViewer } from '../src/index';
import { sharedTextures } from '../src/gltf';

const params = new URLSearchParams(location.search);
const manifest = params.get('manifest');
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
if (!manifest) throw new Error('?manifest=<url to 3d/manifest.json> is required');
const manifestUrl = new URL(manifest, location.href);
// The static server exposes the transcoder at <origin>/basis/.
const viewer = new CityViewer(canvas, { antialias: false, maxPixelRatio: 1, ktx2TranscoderPath: `${manifestUrl.origin}/basis/` });

type Vec3 = readonly [number, number, number];
function goto(eye: Vec3, target: Vec3): void {
  viewer.setCameraPoseConstraintsEnabled(false);
  viewer.applyView({ position: eye, target, fov: viewer.captureView().fov });
}

function stats() {
  return { ...viewer.getStats(), sharedTextures: sharedTextures.stats() };
}

async function ready(quietFrames = 30, timeoutMs = 120_000): Promise<void> {
  const started = performance.now();
  let quiet = 0;
  while (quiet < quietFrames) {
    if (performance.now() - started > timeoutMs) throw new Error(`viewer did not settle: ${JSON.stringify(stats())}`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const s = viewer.getStats();
    quiet = s.loading === 0 && s.queued === 0 && s.uploading === 0 && s.pendingBytes < 1 ? quiet + 1 : 0;
  }
}

function tick(): void {
  const s = stats();
  hud.textContent = `tiles ${s.residentTiles} assets ${s.residentAssets} resident ${(s.residentBytes / 1e6).toFixed(1)} MB pending ${(s.pendingBytes / 1e6).toFixed(1)} MB loading ${s.loading} queued ${s.queued} uploading ${s.uploading}\n`
    + `ktx2 cache: ${s.sharedTextures.textures} textures ${(s.sharedTextures.bytes / 1e6).toFixed(1)} MB refs ${s.sharedTextures.refs} hits ${s.sharedTextures.hits} misses ${s.sharedTextures.misses}`;
  requestAnimationFrame(tick);
}

declare global {
  interface Window { __simforge: { viewer: CityViewer; goto: typeof goto; ready: typeof ready; stats: typeof stats; loaded: Promise<void> } }
}
window.__simforge = { viewer, goto, ready, stats, loaded: viewer.loadMap(manifestUrl.href) };
tick();
