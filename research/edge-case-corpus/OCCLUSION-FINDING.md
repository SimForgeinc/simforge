# The occlusion clause: a requirement-B failure found, made enforceable, and paid for

## What happened
The round-6 audit checked requirement B's clause *"zero occlusion_unproven where occlusion is the
mechanism"* and found that all **10 admitted C7.occlusion archetypes had `declaredOcclusion` EMPTY**
(0/30 traces). `occluderIneffective` read 0 — but only because **nothing had ever been declared**.
A zero that looks like a pass and is not one.

## Root cause
The tool surface had **no occlusion operation**. The agent could place an occluder prop, but nothing
emitted the `occludes: {observer, target}` declaration the engine needs in order to prove occlusion.
The schema supports it (`packages/scenario/src/schema/v2/props.ts`), together with
`targetRevealToConflictS`, which the materializer uses to nudge the prop until the simulated
reveal-to-conflict time matches.

## What I built (general, not per-scenario)
`ScenarioBuilder.occlude(observer, target, catalog_id, side, count)`.
The agent declares only **who is hidden from whom, and with what object**. Everything geometric is solved:
- the occluder's station is **derived from the TARGET's own longitudinal expression**, because an occluder
  only occludes if it lies between observer and target — it is not an independent free parameter;
- `occluderStandoffM` (how far upstream of the target it sits) is SOLVED;
- `revealToConflictS` (how long the target is visible before the conflict) is SOLVED.

Result: `declaredOcclusion` went from **0/30 to 160/160**. Occlusion is now *declared and measurable*.

## But it does not yet BLOCK
Across trials (hedge run, box truck, a 3-van parked row, standoffs 1-12 m), the status is overwhelmingly
`never_blocked_before_conflict` — only ~1/80 reached `revealed_before_conflict`.
The likely reason is blocker **B5**: `props.pose.tFrac` is clamped to [-1, 1], i.e. the lane edges, so the
**verge is unaddressable**. A roadside occluder cannot be placed outside the carriageway, where a hedge,
wall or parked row actually sits. The occluder ends up at the same lateral position as the VRU it is
supposed to hide.

## The consequence, paid rather than argued away
Gate **v2** (pre-registered `3823182614e5a5ba`) adds criterion **C6**: a brief whose mechanism is
occlusion is admitted only if the trace shows the target was genuinely hidden and then revealed before the
conflict, with `occluderIneffective` empty. This is a **TIGHTENING**; nothing was loosened.

Under gate v2, **0 of the 10 C7 archetypes survive**. They are **withdrawn**.

| | gate v1 | gate v2 |
|---|---:|---:|
| archetypes | 99 | **89** |
| categories | 15/15 | **14/15** |
| DEV | 0.521 | 0.466 |
| HELDOUT | 0.452 | 0.407 |
| gap | +0.069 | +0.058 (p=0.417) |

Losing 10 archetypes and a whole taxonomy category is the correct outcome. The alternative — keeping
scenarios that call themselves occlusion scenarios without ever occluding anything — is precisely the
2026-08-03 anti-goal this project exists to avoid.

## To actually close C7
Lift the `tFrac` clamp for props (or add a `lateral_m` / `reference:'verge'` placement form) so an
occluder can sit off the carriageway. That is an engine change in the props schema and materializer, and
it is the single blocker standing between this corpus and a proven occlusion category.

---

## Update: the mechanism was found, but C7 still does not close

`occlude()` now defaults to a **tall vehicle in the ADJACENT lane** (`laneOffset=-1, tFrac=0`), which is the
placement that actually blocks a sight line. Measured progression:

| configuration | occlusion proven |
|---|---:|
| before (no occlusion op at all) | 0/30 |
| hedge at ego-lane edge (tFrac -1) | 0/80 |
| box truck, adjacent lane | **9/80** (median reveal 2.61 s) |
| after occlusion-only solve | 14/400 (3.5%) |
| **joint occlusion + criticality solve** | **1/120 proven, 0 admissible** |

Solving for occlusion alone **loses criticality**; the joint objective finds almost nothing. This is the
same objective-misalignment lesson as before, but here the two objectives are close to mutually exclusive
under the available geometry.

**Why it cannot generalise:** the adjacent-lane workaround needs a multi-lane road, and
`throughLanesSameDir >= 2` fails at **157/210** candidate sites on these maps. So even where it works, it
cannot transfer to >=2 maps and >=3 sites, which requirement B demands.

**C7 remains open, with a precisely scoped fix**: give props a lateral placement form that can reach the
verge (`lateral_m` with `reference:'lane_edge'|'verge'`) in `FramePoseSchema` plus the materializer's
lateral resolution. Until then, an honest corpus has **14/15 categories**, not 15.
