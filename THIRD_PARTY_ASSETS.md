# Third-party asset ledger

This ledger covers assets added by SimForge itself. Original external map
bundles retain their upstream provenance and are not redistributed by the
runtime material feature.

| Asset | Source | License | SHA-256 | Notes |
|---|---|---|---|---|
| Built-in procedural surface pack | `packages/viewer/src/surface-materials.ts` | Apache-2.0 | N/A (source code) | In-house shader code; no image, texture, model, or third-party payload. |
| Three.js Basis Universal transcoder (generated copies only) | `three@0.182.0/examples/jsm/libs/basis` | MIT / Apache-2.0 Basis Universal components; see bundled README | Recorded per generated map manifest | Copied only into ignored local derivative folders when KTX2 is explicitly built. |
| Khronos KTX-Software tools (local toolchain only) | `https://github.com/KhronosGroup/KTX-Software/releases/tag/v4.4.2` | Apache-2.0 | Official Darwin arm64 package: `500bd8f9d63358c3f3a0d83b724c8574436a72c37dc0e4bad90ec1ca38032c3c` | Official signed package is unpacked under the ignored `.tools/map-derivatives/` directory; binaries are never shipped with the app. Per-file hashes are pinned in `config/map-derivative-toolchain.json`. |

Any future texture pack must add its canonical URL, author, exact license,
version, and file SHA-256 here before it can be enabled in a production build.
