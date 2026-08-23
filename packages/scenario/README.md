# @simforge/scenario

The scenario document: schemas, edit history, (de)serialization, migrations,
validation and persistence. Framework-free TypeScript — no React, no three.js,
no DOM beyond an optional `localStorage`.

Two document kinds live here, and they are genuinely different claims:

| | v1 — **scene** | v2 — **template** |
|---|---|---|
| what it says | "these actors, at these coordinates, on this map" | "this kind of place, these roles, this choreography" |
| portable? | no, by construction | yes, by construction |
| entry points | `ScenarioDocument`, `parseScenario`, `migrate` | `parseTemplate`, `validateTemplate`, `migrateToTemplate` |
| schema | `src/schema/v1.ts` | `src/schema/v2/` |

v1 is unchanged and still what `studio` edits. v2 is the authoring format
for retargetable scenarios and the emission target for LLM agents — jump to
[Schema v2](#schema-v2--the-portable-scenariotemplate).

```ts
import { ScenarioDocument, WebScenarioFileStore } from '@simforge/scenario';

const doc = ScenarioDocument.create({
  name: 'Yale & Grant unprotected left',
  map: { mapId: 'yale-street', mapName: 'Yale Street' },
});

const id = doc.addEntity({
  kind: 'vehicle',
  model: { catalogId: 'sedan.generic' },
  pose: { position: { x: 118.25, y: 0, z: -402.5 }, headingRad: Math.PI / 2 },
});

doc.updateEntity(id, { label: 'Ego', pose: { position: { x: 120 } } });
doc.undo();

const store = new WebScenarioFileStore();
await store.write('yale-left-turn', doc);
doc.markClean();
```

## Layers

| Module | What it owns |
| --- | --- |
| `schema/v1.ts` | The zod schema and its inferred types. Source of truth. |
| `json-schema.ts` + `schema/scenario.v1.schema.json` | Generated JSON Schema for non-TS consumers. |
| `operations.ts` | The closed set of edits (`ScenarioOp`) and how they apply. |
| `document.ts` | `ScenarioDocument`: apply, undo/redo, dirty flag, `subscribe`. |
| `serialize.ts` | Canonical text: key order, float precision, freezing. |
| `migrate.ts` | Version dispatch for the v1 lane. |
| `stores/` | `ScenarioFileStore` + in-memory and `localStorage` implementations. |

(The v2 modules are listed [below](#modules).)

## Frame conventions

`pose.position` is the **scene frame**: metres, **y-up**, the same frame
`CoordinateFrame.localToScene` in `@simforge/maps/opendrive` produces and the
same one `manifest.scene.bounds` is expressed in. No translation is applied —
scene coordinates are absolute OpenDRIVE-local coordinates, re-axed as
`scene = (x, z, -y)`.

`pose.headingRad` is radians **CCW about +Y from +X** (right-hand rule, so +X
rotates toward −Z). Two consequences worth knowing:

- It is exactly `Object3D.rotation.y` in three.js, so the renderer needs no
  conversion.
- It is **numerically equal to the OpenDRIVE heading** of the same direction. A
  local heading `h` points along `(cos h, sin h, 0)` in the z-up frame, which the
  axis map sends to `(cos h, 0, −sin h)` — which is `+X` rotated by `h` about
  `+Y`. Positions need converting when crossing the frame boundary; headings do
  not. `src/__tests__/frame-convention.test.ts` pins this, and will fail if
  xodr-tools ever changes its axis map.

Headings are stored folded into `(-π, π]`.

Vertical convention: `position.y` is the **ground contact point** of the actor,
not its centroid. `dims` (when present) describes the full bounding box, so a
renderer places the model at `y + height/2` if its origin is centred.

## Schema decisions

**Strict everywhere, with one escape hatch.** Every object rejects unknown keys,
so `heading` instead of `headingRad` is a load error rather than silent data
loss. The exception is `extensions`, an untyped `Record<string, unknown>`
available on the document root and on every entity. Third-party tools and
in-flight experiments put their data there; nothing in this package interprets
it, and serialization preserves it verbatim.

**Scene pose is authoritative; `laneRef` is advisory.** When a placement was
lane-snapped we store both representations, but a loader must reconstruct the
transform from `pose`. That keeps files renderable without an `.xodr` in hand
and avoids making every load depend on lane-graph resolution. v2 did not promote
`laneRef` to authoritative — it replaced the whole placement model with
frame-relative roles instead, and carries the v1 `laneRef` through the migration
untouched.

**Reserved blocks are present but empty.** `routes`, `triggers`, `lightPrograms`
(`maxItems: 0`) and `parameters` (`additionalProperties: false`) exist in v1 and
writing anything into them is a validation error, on purpose. They paid off in a
way worth recording: because no v1 file can contain a route or a trigger, v2 was
free to define those concepts from scratch (as `route` interactions and the
trigger grammar) without a single compat question.

**Two constraints live in code, not in JSON Schema:** entity ids must be unique
within a document, and `meta.modifiedAt` must not precede `meta.createdAt`. Both
are `.check()` refinements on `ScenarioV1Schema` and are called out in the
generated JSON Schema's `description`.

**Entity ids are ULIDs by construction, opaque by validation.** `newId()` mints
canonical 26-char ULIDs (lexicographic order = creation order, which makes
diffs and undo logs readable), but the schema accepts any URL-safe token up to
64 chars so fixtures and ids from other tools stay loadable.

## Determinism and float precision

`serializeScenario()` guarantees byte-identical output for identical content:

1. Object keys are sorted **lexicographically, recursively** — not in schema
   declaration order, which would rewrite every file whenever the schema is
   refactored.
2. Array order is preserved (`entities` is the author's outliner order).
3. Numbers are rounded to **6 decimal places** — 1 µm for scene metres, 1 µrad
   for headings. Four orders of magnitude finer than anything a user can place,
   and finer than the map pipeline's own ~7 m calibration residual. It kills
   `0.30000000000000004`-style diff noise, and it is idempotent.
4. `-0` becomes `0`; non-finite numbers are rejected (JSON cannot carry them).
5. Two-space indent, one trailing newline.

Operations quantise the geometry they write to the same 6 decimals, so the
in-memory document never holds a value the file cannot represent: **write then
read is an exact identity**, not an approximate one. (Numbers nested inside
`extensions` are opaque to this package and are only quantised on the way to
disk.)

## Edit history

Every mutation runs through immer's `produceWithPatches`. The inverse patch sets
*are* the undo stack, which buys three things:

- undo entries cost bytes, not whole document copies;
- structural sharing means `prev.entities[i] === next.entities[i]` for untouched
  entities, so a future React layer can memo on identity;
- no operation can forget to write its own inverse.

The stack is bounded (200 entries by default). `isDirty` is derived from the
undo cursor rather than a flag, so undoing back to the last save clears it — and
when the saved point is orphaned (by a new edit on a different branch, or by
falling off the end of a trimmed history) the document stays dirty rather than
lying about it.

`subscribe(listener)` is a plain callback set. Binding it to a UI framework is
the caller's job.

Operations validate before committing: a rejected op leaves the document
byte-identical, with no history entry and no notification.

## Persistence

`ScenarioFileStore` is async and name-keyed, because the implementation that
matters most — the Electron `fs` adapter — is both. `read()` returns a
*validated, migrated* document rather than text, so every adapter round-trips
through the canonical serializer and corruption fails at the boundary.

- `MemoryScenarioFileStore` — tests and scratch. Stores canonical text, so tests
  exercise the same path as disk.
- `WebScenarioFileStore` — browser `localStorage`, injectable for Node tests.
  OPFS was the alternative and lost: worker-only sync handles in Safari, engine
  differences that need shims, and no way to unit-test outside a browser. A
  scenario is a few KB (no geometry ever lands here), so the ~5 MB origin quota
  holds thousands of documents — and when it does not, the answer is the
  Electron `fs` adapter, which the async interface already accommodates.

Files from a *newer* schema are rejected with an actionable message rather than
being partially parsed.

## Schema v2 — the portable `ScenarioTemplate`

```ts
import { parseTemplate, validateTemplate } from '@simforge/scenario';

const template = parseTemplate({
  scenarioVersion: 2,
  meta: { name: 'LTAP/OD', createdAt, modifiedAt, appVersion, archetype: 'C3.ltap-od' },
  params: { declarations: [{ id: 'vEgo', type: 'continuous', range: [30, 55], tier: 1 }] },
  anchor: {
    corridor: { throughLanesSameDir: { value: [1, 2] } },
    features: [{
      id: 'jx',
      kind: 'junction',
      arms: { value: [4, 4] },
      control: { value: ['signalized'] },
      conflictingApproach: { value: { from: 'opposing', turn: 'left' } },
    }],
  },
  roles: [
    { id: 'ego', kind: 'on_reference', actor: { class: 'car' },
      pose: { s: -80 }, initialSpeedKph: 'param.vEgo' },
    { id: 'challenger', kind: 'conflicting_gate', actor: { class: 'car' },
      feature: 'jx', from: 'opposing', turn: 'left',
      arriveAtConflict: { relativeTo: 'ego', deltaT: 0.4 },
      initialSpeedKph: 'clamp(0.6 * lane.speedLimitKph, 15, 40)' },
  ],
  choreography: {
    clipSeconds: 20,
    interactions: [
      { id: 'commit', actor: 'challenger', verb: 'set', trigger: { kind: 'at', t: 0 },
        target: { key: 'rules.collisionAvoidance', value: false } },
      { id: 'turn', actor: 'challenger', verb: 'route',
        trigger: { kind: 'when', byLatest: 12,
          condition: { kind: 'ttc', of: 'challenger', to: 'ego', op: '<', valueS: 2.2 } },
        target: { mode: 'turn', feature: 'jx', turn: 'left' } },
    ],
  },
  invariants: [{ id: 'crit', kind: 'ttc', of: 'ego', to: 'challenger', range: [1.2, 2.5] }],
  metricSubject: 'ego',
});

const report = validateTemplate(template);          // document-only checks
const bound  = validateTemplate(template, context); // + map-dependent checks
```

There is no coordinate and no road id anywhere in that document, and none is
expressible: an anchor names lane counts, junction classes and turn relations,
and every pose is `(k, s, tFrac, headingOffsetRad)` in the frame the matcher
establishes. That is the whole retargeting mechanism — see
`docs/research/retargeting.md`.

### Modules

| Module | What it owns |
| --- | --- |
| `schema/v2/anchor.ts` | `LogicalAnchor`: corridor clauses, features, policy, pin. |
| `schema/v2/roles.ts` | `RoleBinding` (8 kinds) and `FramePose`. |
| `schema/v2/interactions.ts` | 7 verbs, 4 triggers, 11 conditions, dynamics, `clipSeconds`. |
| `schema/v2/set-keys.ts` | The typed key registry behind the `set` verb. |
| `schema/v2/invariants.ts` | What must survive retargeting. |
| `schema/v2/params.ts`, `variants.ts`, `props.ts`, `environment.ts` | Parameterisation, author-defined renditions, L3 props, L5 environment. |
| `expr/` | Typed numeric expression AST, string parser, evaluator. No `eval`. |
| `validate/` | Tier-1 validator, `ClauseResult`, the `MapContext` seam, an in-memory fake. |
| `migrate-v2.ts` | v1 scene → v2 template, with notes for everything it will not guess. |
| `json-schema-v2.ts` + `schema/*.v2.schema.json` | Three published schemas. |

### Expressions, not literals

`65` is wrong on a residential street and wrong on a motorway;
`clamp(0.9 * lane.speedLimitKph, 25, 65)` transfers. Every speed, gap, offset,
time and threshold in v2 is `number | Expr`. Authors write the string form and
it is parsed to an AST on load (`printExpr` converts back). The identifier set
is closed — `lane.speedLimitKph`, `lane.widthM`, `junction.sizeM`,
`clip.seconds`, `param.*` — with `+ - * /` and `clamp/min/max/abs`, so an
expression can be rejected but never executed.

Site-dependent expressions are **indeterminate**, not invalid, before a map is
bound; parameter-only expressions evaluate at their declared defaults, which is
what makes the static timeline analysis possible at authoring time.

### One axis, one owner

Five axes — longitudinal, lateral, topology, existence, and one per `set` key.
Later preempts earlier, so a *sequence* on one axis is legal by construction and
the validator only has to find what is genuinely undecidable:

- two statically equal exact start times on one `(actor, axis)` → **error**;
- an explicit `until` that a later exact start truncates → **error** (the
  `until` is a lie);
- two conditional windows that overlap → **warning** (order not statically
  determined);
- exact-vs-window → **silent**, because "cruise, then brake when close" is the
  normal shape and warning on it teaches people to ignore the validator.

### Validation output

One `ClauseResult` shape — `{path, severity, code, message, required?, actual?}`
— shared with the future matcher, so a failed anchor clause and a failed check
render through the same component and repair loop. Codes are stable strings
(`ISSUE_CODES`); an agent keys off them.

Map-dependent checks (`role_unbound`, `route_disconnected`,
`illegal_lane_change`, `wrong_lane_type`, `spawn_off_lane`, `spawn_overlap`,
`runway_insufficient`, `trigger_unbindable`, `speed_over_limit`) run only when a
`MapContext` is injected. That interface is declared here and implemented by
`map-intel` later; `createFakeMapContext` is a working in-memory implementation
for tests and for anyone who needs the validator before `map-intel` lands.

### Published JSON Schemas

`pnpm run schema` writes four files, all drift-guarded by tests:

- `schema/scenario.v1.schema.json` — the v1 scene;
- `schema/scenario-template.v2.schema.json` — the whole template;
- `schema/logical-anchor.v2.schema.json` — **the LLM emission target**;
- `schema/interactions.v2.schema.json` — the timeline alone.

The recursive expression AST is shared through `$defs` rather than inlined —
without that the template schema is 2.4 MB instead of 99 KB and useless as a
decoding grammar. Rules JSON Schema cannot express (mandatory `dynamics`,
mandatory `byLatest`, one-axis-one-owner, the `set` registry) are spelled out in
each schema's `description`, so a model reading the schema still sees them.

### Migrating a v1 scene to a v2 template

`migrateToTemplate(json)` accepts either version and always returns a v2
template plus a list of `MigrationNote`s. What it will **not** do is invent
frame coordinates: converting `(x, y, z)` to `(k, s, tFrac)` needs the lane
graph, which lives in `map-intel`. So every v1 entity becomes a
`scene_absolute` role that keeps its pose verbatim, the anchor is pinned to the
source map with **no** `siteId` (v1 had none to preserve), and the validator
reports `non_portable_role` + `pin_site_unresolved` until someone rebinds it.
A migration that says "I cannot do this part" is worth more than one that
quietly does it wrong.

### Adding schema v3

1. Add `src/schema/v3/` and a `ScenarioMigration` to `TEMPLATE_MIGRATIONS`.
2. Bump `SCENARIO_TEMPLATE_VERSION`.
3. Add a fixture test per step — `runMigrations` takes the chain and the
   validator as options precisely so each step is testable in isolation.
4. `pnpm run schema` to regenerate (a test fails if you forget).

## Scripts

```sh
pnpm --filter @simforge/scenario test        # vitest
pnpm --filter @simforge/scenario typecheck   # tsc --noEmit
pnpm --filter @simforge/scenario schema      # regenerate JSON Schemas
```
