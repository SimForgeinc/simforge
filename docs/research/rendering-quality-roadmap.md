# Rendering quality roadmap — state of the art survey & adoption plan

Surveyed 2026-07-31. Goal: push the three.js viewer to the practical realism
ceiling for our content (PBR city meshes + baked path-traced lighting) while
holding the 60 fps / low-stall perf gates. Everything lands behind quality
presets (High/Balanced/Fast) and the bench harness — no effect ships without a
measured cost.

## Foundation (prerequisite for everything below)

- **three r183+ `RenderPipeline`** — the node-based replacement for
  EffectComposer, built on TSL; composable pass nodes, WebGPU-first with WebGL2
  fallback from the same code. We upgrade from r182 and build the whole post
  stack on this. The baked-shadow-atlas material patch (currently
  `onBeforeCompile`, a WebGL-ism) gets rewritten as a TSL node sampling the
  atlas by world-XZ — cleaner and backend-portable.
- **Physical camera exposure** (ISO/aperture/shutter-style exposure control)
  + **AgX tone mapping** as the default response curve.

## Tier 1 — always on (the "it looks professional" layer)

| Effect | Implementation | Why |
|---|---|---|
| TRAA (temporal AA) | three TSL `TRAAPassNode` | Biggest single realism lever: kills edge shimmer on buildings/wires/lane lines |
| Ambient occlusion | three TSL GTAO node; evaluate **n8ao-webgpu** (TSL port of N8AO, best-in-class quality/perf) side-by-side | Contact depth on top of baked AO textures; grounds everything |
| Bloom | three TSL bloom node, thresholded | Natural highlight response (glass, lenses, car paint) — not uniform glow |
| Color pipeline | AgX + LUT/color-grade node | Filmic consistency; per-map grade possible |
| Baked shadow atlas (TSL rewrite) | ours | Free path-traced sun shadows — our unfair advantage |

## Tier 2 — targeted, per-surface / per-scene

- **SSR on the road layer only** — `road.glb` is a separate static layer, so
  asphalt gets targeted roughness + screen-space reflections (wet-look presets)
  without paying for SSR on facades. three TSL SSR node.
- **Aerial perspective / atmosphere** — distance haze is the #1 cue for
  city-scale outdoor realism. SOTA in the ecosystem:
  **@takram/three-atmosphere** (precomputed Bruneton-style scattering, aerial
  perspective; part of takram three-geospatial, currently GLSL with WebGPU/TSL
  support planned). Interim: physically-plausible height fog + Rayleigh tint
  in TSL (cheap, ~80% of the visual win); swap to takram when its TSL lands.
- **Dynamic-actor shadows** — one tight shadow cascade for placed
  cars/pedestrians only (static city keeps baked shadows); contact-shadow
  fallback at distance.
- **Photo framing** — DOF (three TSL node), vignette, subtle grain; off in
  editing, on in a "cinematic" toggle.
- **Vehicle materials** — `MeshPhysicalMaterial` clearcoat + anisotropy for
  the P2 actor cars (car paint reads instantly as real).

## Tier 3 — showcase / later

- **SSGI** — screen-space global illumination: three's TSL SSGI work and
  **0beqz/realism-effects v2** (SSGI + TRAA + motion blur; v2 in development
  with quality/perf improvements). Evaluate when stable on WebGPU; SSGI is the
  bridge between baked static GI and dynamic actors influencing bounce light.
- **Photo mode: three-gpu-pathtracer** (gkjohnson) — progressive path tracing
  of the *same* scene graph for offline-quality stills (scenario review,
  marketing). Not interactive; runs as an explicit mode.
- **Volumetric clouds** — **@takram/three-clouds** (geospatial volumetric
  clouds with Beer shadow maps, casts shadows on the scene). Pairs with the
  atmosphere package.
- **Night mode** — we know every traffic light head position + state
  (signals.geojson + light programs later): emissive lens nodes into bloom,
  street lighting from the props layer, headlight spotlights on actors,
  fog scattering. A uniquely *authorable* realism feature — few tools can do a
  correct night intersection because few tools know where the lights are.
- **Gaussian-splat context layer** — Spark 2.0 (World Labs) streams/LODs huge
  3DGS worlds inside three.js and mixes with mesh objects; the path to
  photographic ground truth if/when real-world captures of our maps exist.
- **Motion blur** (realism-effects / TSL node) — for playback and photo mode
  only, never while editing.

## Perf guardrails (non-negotiable)

- Every tier lands behind the preset system; degradation order: Tier 3 → Tier
  2 → Tier 1 post → LOD bias. Presets map to measured budgets on reference
  hardware (this MacBook Pro first).
- The bench harness gains a per-pass cost readout (GPU timers where WebGPU
  allows) so each effect's ms cost is known, not vibes.
- WebGL2 fallback stays green in CI for every Tier 1 effect; Tier 2/3 may be
  WebGPU-only where the fallback isn't worth the maintenance.

## Sources / references

- three.js r183 RenderPipeline + TSL post-processing node system
  (threejsroadmap.com post-processing guide 2026; threejs.org TSL docs)
- n8ao-webgpu — github.com/marioandf/n8ao-webgpu (TSL adaptation of N8AO)
- realism-effects — github.com/0beqz/realism-effects (SSGI v2 WIP)
- three-gpu-pathtracer — github.com/gkjohnson/three-gpu-pathtracer
- takram three-geospatial — github.com/takram-design-engineering/three-geospatial
  (@takram/three-atmosphere, @takram/three-clouds; TSL/WebGPU planned)
- Spark 2.0 — worldlabs.ai/blog/spark-2.0 (3DGS streaming/LOD in three.js)
