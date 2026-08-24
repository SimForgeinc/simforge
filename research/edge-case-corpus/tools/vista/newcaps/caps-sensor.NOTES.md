# caps-sensor — the perception layer

## What was missing

`packages/scenario/src/schema/v2/sensors.ts` declared an `ActorSensor` with a `dash_camera`
type and **nothing consumed it**. Worse than absent: `parseSimScenarioInput` *silently stripped*
the field, so a template could declare a camera, validate clean, and simulate as though it had
said nothing. Occlusion was purely geometric, so an entire class of edge case — the ones where the
danger IS the perception failure — was inexpressible.

## What exists now

| capability | where |
|---|---|
| declarative sensors (`dash_camera`, `lidar`, `radar`) with a physical detection model | `scenario-model/schema/v2/sensors.ts`, `sim-engine/src/perception/schema.ts` |
| the detection model itself — closed form, deterministic | `sim-engine/src/perception/model.ts` |
| the per-tick pass and episode summary | `sim-engine/src/perception/runtime.ts` |
| first-class trace channel `ticks.sensors[observer/sensorId]` + `metrics.perception` | `sim-engine/src/trace/sensor-track.ts` |
| `detected(of, by, sensor?)` trigger condition — the reaction is genuinely in-loop | `schema/input.ts`, `sim/triggers.ts`, `interactions.ts` |
| map/percept divergence, declared and recorded | `sensors.ts` (`TemplatePerceptionSchema`), `perception/schema.ts` |
| invariants: `detection_gap`, `time_to_first_detection`, `perception_lag`, `map_divergence` | `invariants.ts`, `cli/src/invariants.ts` |
| lowering | `scenario-materializer/src/perception.ts` + a passthrough in `materialize.ts` |

Nothing here is a renderer or a sensor simulator. There is no image, no point cloud, no noise
process. The model answers exactly one question — *does this sensor report this actor on this
tick, and if not, which physical term prevented it* — as a product of terms each written in the
same `1 - threshold/actual` form:

| term | limit it encodes | reaches 0 at |
|---|---|---|
| contrast | Koschmieder extinction vs the detector's floor ε | `V·ln(1/ε)/3.912` |
| resolution | minimum resolvable angular height θ | `h/θ` |
| illumination | minimum scene illumination | — |
| glare | a bright source within `halfAngle` of the target's bearing | — |

With ε = 0.02 the first row *is* the classical definition of visual range, so `fogVisibilityM: 60`
means what a weather report means by it. Per-modality `sensitivity` exponents make a radar's
indifference to fog and a lidar's indifference to darkness fall out of the same evaluator rather
than out of a branch on sensor type. Glare covers both the sunset sun (from
`environment.sunElevationDeg`, which already existed) and flashing emergency lights (from a
`lights.*` state key, so it is not hard-coded to any actor class).

## End-to-end proof

Two templates differing **only** in `environment.weather`; 30 cells each, five maps, 2 draws,
3 sites per map. `EVIDENCE-caps-sensor-fog-vs-clear.json` has the per-pair table.

| quantity | clear | dense fog |
|---|---|---|
| `firstLineOfSightT` | — | **bit-identical to clear in all 24/24 pairs** |
| perception lag (LOS open → camera reports her) | 0.00 s, every pair | 1.80 / **5.40** / 8.98 s (min/median/max) |
| brake trigger delay vs the clear run | 0 | 1.80 / **5.40** / 8.98 s |
| clearance at closest approach | 62.6 m median | **21.0 m** median, smaller in every pair |
| dominant recorded gap reason | — | `atmospheric_attenuation` in every pair |

Geometry is identical, dynamics are identical, the trigger is identical. The entire delay is
perception. Run the fog template's `perception_lag [4, ∞]` invariant against the clear traces and
it is violated 24/24 — the invariant genuinely discriminates.

## Defects found along the way

1. **Self-occlusion** — the engine promotes static actors to occluders, so a static target occluded
   the sight line to *itself*. Real, reproducible, and **latent**: measured 0/14,309 corpus
   declarations affected. Written up in `DEFECT-self-occlusion.md`; the fix is caps-reverse's file.
2. **Koschmieder's 3.912 pairs with a 2% contrast threshold, not 5%** — my defaults were 30% out
   in range until the test caught it.
3. **Fog was double-counted.** `operationalConditions.effects.visibilityRangeM` is the
   pre-perception stand-in for weather: one hard range that a fog preset shortens. Applying it to
   the sensor sight line as well attenuated the same fog twice and, worse, recorded the result as
   `occluded` — blaming geometry for what is actually the air. A declared sensor now owns its own
   range through `aperture.farM` and the contrast model.
4. **`retired` ≠ gone.** Perception reported a body at its terminal pose while the trigger helper
   rejected it, so `detected` disagreed with the channel the trace had just recorded.
5. **The one-interaction probe.** `parseInteraction` validates an interaction inside a synthetic
   one-actor world, so every `detected()` failed there with "unknown actor" — the same class of bug
   the `after()` BUGFIX comment above it describes, and fixed the same way.

## Deliberate non-decisions

- Map/percept divergence is **recorded exposure, not a closed loop**. The engine has no
  lane-keeping perception controller to mislead; manufacturing a steering error from a faded line
  would be a fiction dressed as a measurement.
- The atmosphere is derived from the existing `environment` block, never re-declared. Two sources
  of truth for "how foggy" is how a preset and a raw intensity end up disagreeing.
- Divergence went in as a **typed template field**, not under `environment.extensions`, which is
  documented as uninterpreted. Hiding a first-class fact in an uninterpreted bag is exactly the
  undiscoverability failure this whole workstream keeps finding. A typed field or no capability.
- The published JSON Schemas were regenerated, so all of it is discoverable from
  `scenario-template.v2.schema.json` rather than only from the source.
