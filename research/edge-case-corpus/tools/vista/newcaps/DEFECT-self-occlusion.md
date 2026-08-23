# DEFECT: an endpoint can occlude itself in `metrics.declaredOcclusion`

**Verdict for the corpus: NOT the cause of `occlusion_unproven`. The surface rule stands.**
The defect is real and reproducible, but it is *latent* — nothing in the corpus reached it.
Do not rewrite the guidance on this account.

Author: caps-sensor. Found while building the perception layer.

## The defect

`Simulation.occludersForTick()` promotes **every static actor** to a line-of-sight blocker
(`id: actor:<id>`). The reveal-to-conflict monitor in `trace/metrics.ts` then tests the segment
between the observer's and the target's *centres* against the relevant occluder set:

```ts
const relevant = monitor.occluderId
  ? occluders.filter((o) => o.id === monitor.occluderId || o.groupId === monitor.occluderId)
  : occluders;                                   // <- everything, endpoints included
const clear = hasLineOfSight(a.position, b.position, relevant, visibilityRangeM);
```

If that set contains a body that *is* one of the endpoints, the segment necessarily crosses its
footprint, so the pair is reported **blocked for the entire clip** and `losOpenT` stays `null`.
No reveal can ever be observed, whatever the actual geometry.

Two reachable ways in:

1. `occlusionPairs[].occluderId` is `.optional()` in `schema/input.ts`. Omit it and *every*
   occluder is relevant — including the target's own body when the target is a static actor.
2. `occluderId: 'actor:<target>'`. This is what `role.extensions.occludes` lowers to
   (`materialize.ts:3016`, `occluderId: actor:${role.id}`) when the declaration is written on the
   **target's own role** rather than on the occluding role. Nothing rejects that.

Reproduced in `packages/engine/src/perception/__tests__/self-occlusion.test.ts`: two bodies on
an empty straight road with *no occluding geometry whatsoever* report `firstBlockedT = 0`,
`losOpenT = null`, status != `revealed_before_conflict`.

## Measurement over the existing corpus

Scanned every `*.trace.json.gz` under `/private/tmp` (103,352 traces) and kept the
14,309 that carry a `declaredOcclusion` entry.

| quantity | count |
|---|---|
| declarations examined | 14,309 |
| **with the TARGET among the blocking bodies** | **0** |
| **with the OBSERVER among the blocking bodies** | **0** |
| with `occluderId` omitted (path 1 above) | 0 |
| with an `actor:` occluder at all | 135 |
| of those, where the actor was an endpoint | 0 |

Every single declaration in the corpus carries an **explicit** `occluderId`, because
`declareOcclusionPair` is only ever called with one — from a prop's `occludes` block
(`occluderId: prop.id`) or from a role's (`occluderId: actor:<role>`). Path 1 is unreachable from a
template; path 2 is reachable but was never taken.

## What actually causes the rejections

Status breakdown over the same 14,309 declarations:

| status | count | share |
|---|---:|---:|
| `revealed_before_conflict` (healthy) | 6,894 | 48.2% |
| `never_blocked_before_conflict` | 4,784 | 33.4% |
| `pair_unobserved` | 1,278 | 8.9% |
| `blocked_at_conflict` | 1,272 | 8.9% |
| `occluder_unobserved` | 81 | 0.6% |

The dominant failure is `never_blocked_before_conflict` — the declared occluder *never blocked the
sight line at all*. That is the author's geometry, not the engine's arithmetic, and it is exactly
what the existing surface rule warns about. The measurement **strengthens** the rule rather than
undermining it.

### The reverse direction, which was the one most worth ruling out

Could self-occlusion make a line look blocked when it should be open, so that a
`revealed_before_conflict` records a reveal that never physically happened? **No.** A reveal is
recorded only on a blocked -> clear transition of the *relevant* set, and in 0 of
6,894 healthy declarations was an endpoint in that
set. The occlusion scenarios in the corpus are doing what the metric says.

One narrower caveat that this scan cannot rule out, because it needs per-tick geometry rather than
the metric summary: a *legitimate* declared occluder whose footprint still contains the target at
the moment of conflict — a pedestrian who has not yet stepped clear of the parked car she is
emerging from. That is not self-occlusion and it is arguably the correct answer, but it means
`blocked_at_conflict` can be reported for a target that a human would call half-visible. Only
1,272 declarations (8.9%)
are in that state at all, so the ceiling on this effect is small.

## Recommended fix (NOT applied — outside my ownership)

In `trace/metrics.ts`, exclude both endpoints from the relevant occluder set, one line:

```ts
const endpoints = new Set([`actor:${a.id}`, `actor:${b.id}`]);
const relevant = (monitor.occluderId ? occluders.filter(...) : occluders)
  .filter((o) => !endpoints.has(o.id));
```

and reject `occluderId === 'actor:<observer>' | 'actor:<target>'` in `simScenarioInputSchema`, so
the nonsensical declaration is unrepresentable rather than silently permanent.

The perception layer already does this: `Simulation.observePerception` filters
`actor:<observer>` and `actor:<target>` out of the occluder set before every sight-line test, and
`self-occlusion.test.ts` pins that it does.
