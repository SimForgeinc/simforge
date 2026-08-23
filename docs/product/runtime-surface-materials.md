# Runtime surface materials

SimForge improves map surfaces at runtime without modifying the external
GLB source assets. The semantic classifier uses object ancestry, mesh name,
material name, layer identity, and a stable geometry digest. It intentionally
defaults to `unknown`; unknown and road-marking materials remain byte-for-byte
equivalent in their authored properties.

The **Original**, **Enhanced authoring**, and **Presentation detail** profiles
change only material color/roughness and add metre-scaled world-space procedural
variation. Geometry buffers, transforms, scenario actors, and camera state are
never modified. Original material properties and shader hooks are restored on
profile changes. The shader wrapper calls the existing baked-shadow hook first
and extends its stable program cache key.

The runtime report includes classification counts, preserved markings, unknown
identity examples, shader-variant count, and material-application time. The
fixed budget is four additional shader variants with no added textures, network
requests, or GPU texture memory.

Ultra Low 3D remains an independent top-priority override. It swaps each map
and actor material to a cached texture-free `MeshBasicMaterial`, preserving its
baked/authored flat color, opacity, sidedness, alpha cutoff, and vertex colors.
Conservative muted semantic colors distinguish roads, markings, grass,
concrete, buildings, roofs, and vegetation when no useful color exists. Actor
paint colors are retained. Leaving Ultra Low restores the selected runtime
surface profile.

## Local optimized derivatives

`pnpm maps:derivatives -- --map <map-id> --mode dry-run --variant all` produces
a read-only plan with source size, worst-case output size, disk headroom, pinned
tool status, and a fail-closed road-tiling assessment. Dry-run is the default.
No map data is written until `--mode build` is explicit.

The build writes only under the selected map's ignored `3d/variants/` folder:

- Versioned `geometry-only-v*/` GLBs replace each base-color texture with a
  deterministic alpha-aware representative color (computed in linear space),
  then remove every texture/image payload. Nodes, transforms, mesh primitives,
  and accessor identities are preserved. Each conversion aborts if its geometry
  identity changes or a texture reference remains.
- `ktx2/` GLBs use the pinned glTF-Transform/UASTC + `toktx` toolchain. A version
  mismatch blocks the build. The matching Three.js Basis transcoder is copied
  with checksums and declared in the variant manifest.
- Road tiles are emitted only when every complete road node fits a spatial cell.
  Any hierarchy or boundary-crossing sheet blocks tiling rather than cutting
  geometry, lane markings, or ground continuity heuristically.
- `static-colliders-v1.json` contains compact scene-frame OBBs for buildings,
  walls, fences, barriers, bollards, guardrails, and explicitly named curbs.
  The builder reads only each lowest-detail GLB's JSON chunk, normalizes
  quantized accessor bounds, and rejects travel-lane overlaps using the map
  topology. The timestamp-free artifact is byte-for-byte deterministic and is
  bound to the source map manifest by SHA-256.
- `manifest.json` contains source/output SHA-256 values, generator versions,
  runtime dependencies, and optional validated static-layer tiles. A new
  generation is written to its own directory and becomes visible only through
  the final atomic manifest replacement, so browsers never observe mixed builds.

The renderer discovers this manifest by convention. Ultra Low selects a
geometry-only file and fails closed if it is unavailable or invalid, preventing
a surprise textured-source fetch. Normal modes can select KTX2 only when its
transcoder is declared and retain source fallback behavior. Starting directly
in Ultra Low also skips HDR environment and baked-shadow atlas requests.

The simulation worker also discovers the collider derivative by convention. It
validates the live map-manifest hash, derivative checksum, schema, and sorted
collider IDs, then caches the result for the worker lifetime. It never inspects
or range-fetches a GLB. A missing, stale, or malformed artifact produces an
empty collider set plus diagnostics immediately; editor preparation does not
wait for an extraction timeout.

The derivatives are local and reproducible, not redistributable source-map
replacements. Original GLBs are never overwritten or deleted.

### Pinned KTX toolchain

KTX-Software 4.4.2 is sourced only from the official Khronos release. On Apple
silicon, the official notarized `Darwin-arm64.pkg` is unpacked without a system
install into `.tools/map-derivatives/ktx-software/4.4.2-darwin-arm64/`. The
release archive SHA-256, executable SHA-256 values, library SHA-256, version,
source URL, platform, and Apache-2.0 license are recorded in
`config/map-derivative-toolchain.json`.

The derivative builder resolves only that workspace-local directory. It does
not fall back to Homebrew or another `PATH` installation. Before any KTX2 work,
it verifies every declared binary and runtime library, checks exact `ktx` and
`toktx` versions, and clears `TOKTX_OPTIONS`. A missing, modified, wrong-version,
or wrong-platform tool blocks KTX2 generation before source assets are read for
conversion. Generated binaries, smoke artifacts, and derivatives remain ignored
local files; the source maps are never overwritten.

glTF-Transform assigns sRGB transfer semantics to base-color and emissive
textures. Normal, occlusion, and metallic-roughness data remain linear; normal
maps also bypass UASTC RDO to avoid directional artifacts. The pinned smoke test
checks these transfer functions with official KTX validation tools before a
full map conversion is allowed.

Run `pnpm maps:derivatives:smoke` before a map-wide KTX2 build. It generates
small representative base-color, emissive, normal, and packed
occlusion/roughness/metalness textures in `.tools/map-derivatives/smoke/`, then
checks each output with the official `ktx validate` and `ktxinfo` commands. It
also converts a real Belmont asset containing base-color, normal, and packed ORM
textures and loads the outputs through Three.js `KTX2Loader` with the same Basis
transcoder used by the renderer.

The tool smoke is green, but map-wide KTX2 generation is intentionally blocked
for the current production bundles. Their embedded WebP textures are skipped by
glTF-Transform 4.3's UASTC command, and that command also decodes/re-encodes
`EXT_meshopt_compression`, changing geometry identity and increasing some files.
The builder's identity gate rejects this and publishes no KTX2 manifest. A
future image-only packer must decode WebP and replace only image payloads while
leaving geometry, accessors, and meshopt byte streams untouched. Geometry-only
derivatives remain independent and safe to build meanwhile.
