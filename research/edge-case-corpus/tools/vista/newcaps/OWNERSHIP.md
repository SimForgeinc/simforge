# Parallel capability workstreams — file ownership

Five agents work the same worktree concurrently. Ownership is strict; collisions corrupt a workstream.

| agent | owns | closes the gap |
|---|---|---|
| `caps-catalog` | `packages/asset-catalog/**`, `scenario-materializer/src/prop-dims.ts`, `roles.ts` (DEFAULT_ACTOR_DIMS + ACTOR_CLASSES only) | no `animal.*` id despite an `animal` actor class; no debris; no traffic furniture |
| `caps-reverse` | `packages/engine/src/**` except `environment*`/`weather*`/`sensors*`/`perception*`; `interactions.ts` if a new target mode is needed | 1 body in 1642 moved >0.8 m backwards — no reversing |
| `caps-surface` | `environment.ts`, `traffic-controls.ts`, `set-keys.ts`, `anchor.ts` (surface_patch only), `sim-engine/src/environment*`, `cli/src/map-signals*` | friction is one global scalar; no signal blackout or flashing arrow |
| `caps-map` | `packages/maps/**`, `packages/maps/**`, `materialize.ts` (lane-offset resolution only), a NEW dev-assets map id | 87.8% of sections are single-lane; materializer silently clamps impossible lane offsets |
| `caps-sensor` | `sensors.ts`, `invariants.ts` (perception invariants only), new `sim-engine/src/sensors*`/`perception*` files | `dash_camera` is declared and nothing consumes it; no perception layer at all |

Rules: never `git commit -a`, never `git checkout`; `git add` only your own files; escalate to the
parent rather than editing another agent's file. Every change needs a failing test first and an
end-to-end scenario in `newcaps/<agent>.template.json` that previously could not be built.
