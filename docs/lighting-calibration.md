# Lighting calibration — one spec, two renderers

This is the single source of truth for outdoor lighting in SimForge. Two
implementations mirror it and MUST cite this document:

- **Three viewer** — `packages/viewer/src/lighting-calibration.ts`
- **Bevy renderer** — `renderer/render-core/src/calibration.rs`

They are deliberately duplicated implementations of ONE spec (a TS package and
a Rust crate cannot share code); any change here lands in both modules in the
same commit.

## Sun model

| Quantity | Value | Rationale |
|---|---|---|
| Extraterrestrial illuminance `E_ext` | 128 000 lx | Solar illuminance constant above the atmosphere (≈128 klx) |
| Clear-sky transmittance `T` | 0.7 | Meinel/Laue clear-atmosphere model |
| Air mass `m(h)` | `1 / (sin h + 0.50572·(h° + 6.07995)^-1.6364)` | Kasten–Young (1989); finite at the horizon |
| Direct-normal illuminance `E_dn(h)` | `E_ext · T^(m(h)^0.678)` | Meinel; ≈89.6 klx at zenith, ≈83 klx at 60°, ≈1.5 klx at 4° |
| Twilight ramp | linear 1→0 from `h = 0°` to `h = −6°` (civil twilight) | matches `sunElevationFalloff` in `packages/viewer/src/sky.ts` |
| Sun colour temperature `CCT(h)` | `2500 K + 3000 K · clamp(h/30°, 0, 1)` | 5 500 K high sun → 2 500 K at the horizon; blackbody → RGB via the Tanner-Helland approximation (`kelvin_to_rgb`) |
| Sun angular diameter | 0.53° | drives PCSS penumbra width |

`h` is sun elevation above the horizon in degrees. Directional-light intensity
is `E_dn(h)` (lux on a surface perpendicular to the sun), NOT a flat
100 klx — dusk scenes must darken through the model, never through an
ad-hoc multiplier.

## Sky / IBL

| Quantity | Value | Rationale |
|---|---|---|
| HDRI normalisation `HDRI_TO_CDM2` | 20 000 cd/m² per luma unit | Map HDRIs are normalised (mean sky luma ≈ 1.26); 20 000 restores physical sky luminance (measured, see `renderer/render-core/src/weather.rs`) |
| Clear-day sky diffuse target | 10–25 klx on horizontal | WMO/CIE clear-day band |
| Shadowed/sunlit ratio target | 0.15–0.25 (linear) on horizontal surfaces | the calibration acceptance band; below it shadows crush, above it the scene washes out |
| Sky brightness vs elevation | scales with `daylight(h) = E_dn(h)·max(sin h, 0) / (E_dn(60°)·sin 60°)`, floored at 0.004 | dusk sky dims with the sun; 0.004 is the measured lit-street/night floor |

When a scene ships no HDRI, both renderers must still be sky-lit: the Three
viewer bakes its analytic sky dome through PMREM (`SkyDome`); the Bevy
renderer generates a deterministic analytic gradient cubemap
(`synthetic_sky_cubemap`) normalised to the same ≈1.26 mean sky luma so
`HDRI_TO_CDM2` applies unchanged.

## Exposure (EV100)

Incident-light convention: `EV100 = log2(E_lx / 2.5)` (ISO 100, C = 250).

| Condition | Fixed EV100 | Check |
|---|---|---|
| Clear day, sun ≥ 30° | 15 | sunny-16: log2(100 000 / 2.5) ≈ 15.3 |
| Fog / overcast | 14 | |
| Rain | 13.5 | |
| Night (lit street) | 9 | |
| Clear, low sun (dusk) | `clamp(15 + log2(E_dh(h)/E_dh(60°)), 9, 15)` | tracks the sun model; ≈9–12 through golden hour |

`E_dh(h) = E_dn(h)·sin h` is direct horizontal illuminance. The **sensor**
profile always uses fixed EV100 (deterministic, hash-stable). The
**cinematic** profile uses the same fixed value until real frame pacing makes
auto-exposure deterministic (see `renderer/render-core/src/profiles.rs`).

## Tonemap

| Output | Tonemap |
|---|---|
| Human-facing (viewer, cinematic profile) | **AgX**, exposure per table above |
| Machine-vision (sensor profile) | none — linear output, fixed EV100 |

## Three-viewer working units

The Three viewer predates the physical pipeline and works in editor units with
`toneMappingExposure = 1`. Its defaults are calibrated against the spec's
*ratios* rather than absolute lux:

| Constant | Value | Spec anchor |
|---|---|---|
| `VIEWER_SUN_INTENSITY` | 5.0 | sun vs sky balance measured so path-traced baked shadows read at street level |
| `VIEWER_ENVIRONMENT_INTENSITY` | 0.6 | lands the shadowed/sunlit ratio inside 0.15–0.25 with the PMREM sky |
| `VIEWER_EXPOSURE` | 1.0 | AgX at datum exposure |

## Materials (clamp policy)

Surface styling must never destroy authored material response:

- **No roughness floors.** The former engine clamp
  `roughness = max(authored, style)` (surface-materials.ts) and the vegetation
  kill `envMapIntensity = 0; roughness = max(roughness, 0.9)`
  (studio tile-manager) are removed. Pack styles now *blend*:
  `roughness = lerp(authored, target, roughnessMix)` with per-class
  `roughnessMix ≤ 0.6`.
- **`envMapIntensity` stays 1.0** unless a user-facing multiplier changes it.
- Dielectric guard: classified ground surfaces (asphalt/grass/concrete/curb)
  cap metalness at 0.04 — that is physics, not styling.

The platform city-viewer (`a100-render-workers`
`apps/web/app/components/city-viewer/streaming/tile-manager.ts`) carries the
same vegetation clamp and needs the identical removal; see the lane patch
note.
