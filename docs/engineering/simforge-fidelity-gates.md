# SimForge scenario-fidelity gates

These checks define the minimum machine-verifiable contract for a generated
scenario instance and its trace. They are correctness gates, not visual-quality
scores.

## D2 — lane-semantic arrival and placement

- A reference-frame arrival carries concrete lane/storage-`s` stations.
- A lane route must match one of those stations. It may not fall back to a
  nearby parallel route merely because the geometry is close.
- Freeform crossing routes have no lane identity and may use the bounded
  geometric projection (maximum 2 m).
- Matcher conflict points only mint lane provenance for the two bound routes
  when the point is within 2 m of each route.
- Moving an actor to its solved spawn preserves its lateral fraction and
  route-relative heading offset in both `laneRef` and the concrete pose.

## D5 — parameterized lateral placement

- Role, prop, repeated-prop, and polyline `tFrac` expressions are evaluated in
  the concrete draw scope.
- The resolved value is clamped to the authored `[-1, 1]` lane-width domain.
- Different parameter draws must produce different concrete `laneRef` and world
  positions; the draw is not allowed to remain cosmetic metadata.

## D6 — declared occlusion evidence

- Occlusion is directional: every record preserves `observer` and `target`, in
  addition to the stable unordered pair used by TTC/distance tables.
- Every authored observer/target/occluder declaration produces exactly one
  `metrics.declaredOcclusion` record.
- Its status is one of `revealed_before_conflict`, `blocked_at_conflict`,
  `never_blocked_before_conflict`, `occluder_unobserved`, or `pair_unobserved`.
- Repeated props resolve their group id to the concrete blocker ids used by the
  line-of-sight calculation.
- Any declared relation without a blocked-to-clear reveal before conflict is an
  `occlusion_unproven` evaluation finding and rejects the scenario.

## Evidence integrity and topology domains

An instance/trace pair is admissible only when all of these joins are exact:

- recomputed canonical input hash = manifest input hash = trace input hash;
- input map id = replay-key map id = trace map id;
- input actor ids = manifest actor ids = trace-header actor ids = trace tracks;
- the replay key independently declares `matcherIndexDigest` and
  `engineGraphDigest`;
- trace `engineGraphDigest` = replay-key `engineGraphDigest`;
- deprecated trace `topologyDigest` is an exact alias of `engineGraphDigest`,
  never a substitute for the matcher domain.

The strict Studio renderer applies the same input/map/actor/topology joins
before producing frames or video.

## Aftermath continuity

Completing a pedestrian route stops its motion but does not implicitly despawn
it. The pedestrian remains at the terminal pose through the aftermath frame,
while its completed motion is excluded from later TTC/collision sampling. An
explicit `exist(absent)` interaction remains the way to remove an actor.

## Focused proof

- `packages/engine/src/__tests__/arrival.test.ts`
- `packages/engine/src/__tests__/occlusion-metrics.test.ts`
- `packages/engine/src/__tests__/route-end.test.ts`
- `packages/engine/src/__tests__/static-actors.test.ts`
- `packages/engine/src/__tests__/triggers.test.ts`
- `packages/cli/src/__tests__/evidence.test.ts`
- `packages/compiler/src/__tests__/materialize.test.ts`
- `scripts/__tests__/export-render.test.mjs`

The focused Yale artifact lives under
`artifacts/qa/golden-yale-bus-stop-20260801-fidelity-gates/`. It is evidence for
one scenario only and does not count toward the 100-per-map catalog.
