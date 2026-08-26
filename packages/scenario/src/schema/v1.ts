/**
 * `.scenario.json` schema, version 1.
 *
 * Design rules that the rest of the package leans on:
 *
 * - **Strict by default.** Every object is a `z.strictObject`, so a typo like
 *   `heading` instead of `headingRad` is a load error rather than silent data
 *   loss. The single escape hatch is {@link ExtensionsSchema}, an untyped
 *   `Record<string, unknown>` bag available on the document root and on every
 *   entity, for experiments and third-party annotations.
 * - **Scene pose is authoritative in v1.** {@link LaneRefSchema} is an optional
 *   *additional* anchor: when the author placed an entity on a lane we persist
 *   both representations, but a loader must reconstruct the transform from
 *   `pose`, never from `laneRef`. That keeps files renderable without an
 *   `.xodr` in hand, and lets v2 promote `laneRef` to authoritative behind a
 *   version bump.
 * - **Reserved blocks are present but empty.** `routes`, `triggers`,
 *   `lightPrograms` and `parameters` exist in v1 with `maxItems: 0` /
 *   `additionalProperties: false`. Files therefore always have the final key
 *   set, and v2 can define real element shapes without a compat break, because
 *   no v1 file can contain an element that v2 would have to reinterpret.
 *
 * ## Frame conventions
 *
 * `pose.position` is in the **scene frame**: metres, y-up, identical to the
 * frame `CoordinateFrame.localToScene` in `@simforge-oss/maps/opendrive` emits
 * and to `manifest.scene.bounds` in the 3D tile manifest.
 *
 * `pose.headingRad` is radians **CCW about +Y from +X** (right-hand rule, so
 * +X rotates toward −Z). This is exactly `Object3D.rotation.y` in three.js,
 * and it is numerically equal to the OpenDRIVE heading of the same direction:
 * a local heading `h` points along `(cos h, sin h, 0)` z-up, which
 * `localToScene` maps to `(cos h, 0, −sin h)`, i.e. `+X` rotated by `h` about
 * `+Y`. Heading needs no conversion when crossing the frame boundary — only
 * positions do.
 */

import { z } from 'zod';

/** The schema version this module describes. */
export const SCENARIO_VERSION = 1;

/**
 * Entity identifier.
 *
 * ULIDs by construction (see `newId()`), but validated as an opaque
 * URL-safe token so hand-authored fixtures and ids minted by other tools stay
 * loadable. Uniqueness within a document is enforced by
 * {@link ScenarioV1Schema}, not by this schema.
 */
export const EntityIdSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/, 'must be a URL-safe id of 1-64 chars');

/** ISO-8601 timestamp, e.g. `2026-07-31T18:04:11.123Z`. Offsets are accepted. */
export const TimestampSchema = z.iso.datetime({ offset: true });

/**
 * Untyped forward-compat bag. The only place unknown keys are legal.
 *
 * Values are `unknown`, so consumers must narrow before use; nothing in this
 * package reads them, and serialization preserves them verbatim.
 */
export const ExtensionsSchema = z.record(z.string(), z.unknown());

/** A point in the scene frame (metres, y-up). */
export const Vec3Schema = z.strictObject({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

/** Rigid placement of an entity in the scene frame. */
export const PoseSchema = z.strictObject({
  /** Position in scene metres (y-up). Ground contact point, not the centroid. */
  position: Vec3Schema,
  /** Radians CCW about +Y from +X. Equal to the OpenDRIVE heading; see module docs. */
  headingRad: z.number(),
});

/**
 * Lane-relative anchor: where the author dropped the entity on the road
 * network. Advisory in v1 — `pose` wins on load.
 */
export const LaneRefSchema = z.strictObject({
  /** OpenDRIVE road id (a string; RoadRunner emits non-numeric ids). */
  roadId: z.string().min(1),
  /** Lane-section index within the road, 0-based. */
  section: z.number().int().min(0),
  /** Signed OpenDRIVE lane id; negative is right of the centreline, 0 is the centre lane. */
  laneId: z.number().int(),
  /** Distance along the road reference line, metres from the road start. */
  s: z.number().min(0),
  /** Lateral offset from the lane centre, metres, positive to the left. */
  t: z.number().default(0),
  /** Yaw relative to the lane tangent, radians CCW (same sign convention as `headingRad`). */
  headingOffsetRad: z.number().default(0),
});

/** Bounding-box dimensions in metres. Optional override of the catalog model's own box. */
export const DimensionsSchema = z.strictObject({
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** What kind of actor an entity is. */
export const EntityKindSchema = z.enum(['vehicle', 'pedestrian']);

/** Reference into the bundled model catalog. Resolution happens outside this package. */
export const ModelRefSchema = z.strictObject({
  catalogId: z.string().min(1),
});

/** A placed actor. */
export const EntitySchema = z.strictObject({
  id: EntityIdSchema,
  kind: EntityKindSchema,
  /** Author-facing name. Absent means "show the catalog name". */
  label: z.string().max(200).optional(),
  model: ModelRefSchema,
  pose: PoseSchema,
  /** Lane anchor captured at placement time, when the placement was lane-snapped. */
  laneRef: LaneRefSchema.optional(),
  dims: DimensionsSchema.optional(),
  extensions: ExtensionsSchema.optional(),
});

/** Document-level bookkeeping. */
export const ScenarioMetaSchema = z.strictObject({
  name: z.string().min(1).max(200),
  description: z.string().max(4000).default(''),
  createdAt: TimestampSchema,
  modifiedAt: TimestampSchema,
  /** Version of the app that last wrote the file, for bug triage. */
  appVersion: z.string().min(1),
});

/** Which map the scenario is authored against. */
export const MapRefSchema = z.strictObject({
  /** Stable map slug, e.g. `yale-street`. */
  mapId: z.string().min(1),
  /** Human-readable map name at authoring time. */
  mapName: z.string().min(1),
  /** SHA-256 of the `.xodr`, lowercase hex. Lets the app warn on map drift. */
  xodrSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'must be lowercase hex sha-256')
    .optional(),
});

/** Reserved list block: present in every v1 file, required to be empty. */
const reservedList = (what: string) =>
  z
    .array(z.unknown())
    .max(0, `${what} is reserved for a future schema version and must be empty in v1`)
    .default([]);

/**
 * The v1 document, without the cross-field checks.
 *
 * Exported separately so migrations and tooling can `.extend()` / `.partial()`
 * it; application code should use {@link ScenarioV1Schema}.
 */
export const ScenarioV1ObjectSchema = z.strictObject({
  scenarioVersion: z.literal(SCENARIO_VERSION),
  meta: ScenarioMetaSchema,
  map: MapRefSchema,
  entities: z.array(EntitySchema).default([]),
  /** Reserved: per-entity paths. Must be empty in v1. */
  routes: reservedList('routes'),
  /** Reserved: condition/action pairs. Must be empty in v1. */
  triggers: reservedList('triggers'),
  /** Reserved: traffic-signal programs. Must be empty in v1. */
  lightPrograms: reservedList('lightPrograms'),
  /** Reserved: named scenario parameters. Must be empty in v1. */
  parameters: z.strictObject({}).default({}),
  extensions: ExtensionsSchema.optional(),
});

/**
 * The v1 document schema. Parse `.scenario.json` with this.
 *
 * Adds the checks a plain object schema cannot express: entity ids must be
 * unique, and `meta.modifiedAt` must not precede `meta.createdAt`.
 */
export const ScenarioV1Schema = ScenarioV1ObjectSchema.check((ctx) => {
  const doc = ctx.value;
  const seen = new Set<string>();
  doc.entities.forEach((entity, index) => {
    if (seen.has(entity.id)) {
      ctx.issues.push({
        code: 'custom',
        message: `duplicate entity id "${entity.id}"`,
        path: ['entities', index, 'id'],
        input: entity.id,
      });
    }
    seen.add(entity.id);
  });
  if (Date.parse(doc.meta.modifiedAt) < Date.parse(doc.meta.createdAt)) {
    ctx.issues.push({
      code: 'custom',
      message: 'meta.modifiedAt precedes meta.createdAt',
      path: ['meta', 'modifiedAt'],
      input: doc.meta.modifiedAt,
    });
  }
});

/** A validated v1 scenario document (all defaults materialised). */
export type ScenarioV1 = z.infer<typeof ScenarioV1Schema>;
/** The shape accepted on input: reserved blocks and `meta.description` may be omitted. */
export type ScenarioV1Input = z.input<typeof ScenarioV1Schema>;

/** A placed actor. */
export type Entity = z.infer<typeof EntitySchema>;
/** Actor kind. */
export type EntityKind = z.infer<typeof EntityKindSchema>;
/** Rigid placement in the scene frame. */
export type Pose = z.infer<typeof PoseSchema>;
/** Point in the scene frame. */
export type Vec3 = z.infer<typeof Vec3Schema>;
/** Lane-relative anchor. */
export type LaneRef = z.infer<typeof LaneRefSchema>;
/** Lane-relative anchor as authored (defaults may be omitted). */
export type LaneRefInput = z.input<typeof LaneRefSchema>;
/** Bounding-box dimensions in metres. */
export type Dimensions = z.infer<typeof DimensionsSchema>;
/** Catalog model reference. */
export type ModelRef = z.infer<typeof ModelRefSchema>;
/** Document bookkeeping. */
export type ScenarioMeta = z.infer<typeof ScenarioMetaSchema>;
/** Map reference. */
export type MapRef = z.infer<typeof MapRefSchema>;
/** Forward-compat bag. */
export type Extensions = z.infer<typeof ExtensionsSchema>;
