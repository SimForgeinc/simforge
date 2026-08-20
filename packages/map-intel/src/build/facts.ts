/**
 * The declared fact vocabulary, and the build-time assertion that keeps it honest.
 *
 * The failure this exists to prevent: the prior system declared
 * `is_t_intersection`, aliased it in three query paths, documented it in the
 * tool schema — and no code path ever wrote it. Every query filtering on it
 * silently returned nothing. So: a fact key that no derivation produces is a
 * **build failure**, not a documentation bug.
 *
 * `scope` distinguishes two honest cases:
 *
 * - `always` — every map must produce this key. A missing one is a real defect.
 * - `conditional` — the key depends on a feature that genuinely may not exist
 *   on a given map (only `easterbrook-discovery-school` has MUTCD school signs,
 *   for instance). These must be produced by *at least one* map in a full
 *   `--all` build, which still catches the declared-but-never-written case.
 *
 * Facts adopted verbatim from the search index are *not* declared here — they
 * are foreign data passed through, and are reported separately by
 * {@link summariseFactKeys}.
 */

/** Declared type of a fact value. */
export type FactKeyType = 'string' | 'number' | 'boolean' | 'string[]';

/** One entry in the declared vocabulary. */
export interface FactKeySpec {
  key: string;
  type: FactKeyType;
  scope: 'always' | 'conditional';
  /** Which derivation writes it — the answer to "who produces this?". */
  producedBy: string;
  description: string;
}

/** The vocabulary this package guarantees. */
export const DECLARED_FACT_KEYS: readonly FactKeySpec[] = [
  // --- universal, written by anchor-lift for every anchored location ---
  {
    key: 'anchor_distance_m',
    type: 'number',
    scope: 'always',
    producedBy: 'anchor-lift',
    description: 'Distance from the location point to its anchored lane centreline.',
  },
  {
    key: 'lane_type',
    type: 'string',
    scope: 'always',
    producedBy: 'anchor-lift',
    description: 'Lane type of the anchor lane (driving/biking/sidewalk/parking/shoulder).',
  },
  {
    key: 'anchor_heading_deg',
    type: 'number',
    scope: 'always',
    producedBy: 'anchor-lift',
    description: 'Compass bearing of lane travel at the anchor (0 = north, clockwise).',
  },

  // --- junction ---
  {
    key: 'arm_count',
    type: 'number',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Number of physical legs meeting at the junction.',
  },
  {
    key: 'derived_control',
    type: 'string',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Control derived from nearby signals: signalized|all_way_stop|minor_stop|yield|uncontrolled.',
  },
  {
    key: 'conflict_pair_count',
    type: 'number',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Number of precomputed crossing movement pairs inside the junction.',
  },
  {
    key: 'has_opposing_conflict',
    type: 'boolean',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'True when some pair of crossing movements approaches from opposing arms.',
  },
  {
    key: 'junction_size_m',
    type: 'number',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Largest extent of the junction footprint, metres.',
  },
  {
    key: 'internal_lane_count',
    type: 'number',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Junction-internal (connecting) lane count.',
  },
  {
    key: 'approach_lane_count',
    type: 'number',
    scope: 'always',
    producedBy: 'junction-descriptors',
    description: 'Inbound lane count across all arms.',
  },

  // --- junction_movement ---
  {
    key: 'turn_relation',
    type: 'string',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'Left | Right | Straight | UTurnLeft | UTurnRight.',
  },
  {
    key: 'heading_change_deg',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'Signed heading change from approach to exit, degrees.',
  },
  {
    key: 'movement_length_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'Length of the connecting lane, metres.',
  },
  {
    key: 'conflicting_movement_count',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'How many other movements in the junction cross this one.',
  },
  {
    key: 'is_protected',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'True when no other movement in the junction crosses this one.',
  },
  {
    key: 'junction_control',
    type: 'string',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'Derived control of the parent junction.',
  },
  {
    key: 'exit_count',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/junction-movements',
    description: 'Number of exit lanes the movement can feed.',
  },

  // --- corridor-ish (midblock_segment, work_zone_suitable) ---
  {
    key: 'lanes_same_dir',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Same-direction through lanes at the location.',
  },
  {
    key: 'lanes_opposing',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Opposing through lanes on the same carriageway.',
  },
  {
    key: 'speed_limit_kph',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Posted/derived speed limit of the anchor lane.',
  },
  {
    key: 'lane_width_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Local lane width at the anchor.',
  },
  {
    key: 'curvature_deg_per_10m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Absolute heading change per 10 m of arc length.',
  },
  {
    key: 'distance_to_junction_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Along-chain distance to the nearest junction entry/exit.',
  },
  {
    key: 'has_parking_adjacent',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'A parking lane sits beside the anchor lane in the same lane row.',
  },
  {
    key: 'has_bike_adjacent',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'A bike lane sits beside the anchor lane.',
  },
  {
    key: 'has_sidewalk_adjacent',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'A sidewalk sits beside the anchor lane.',
  },
  {
    key: 'has_shoulder_adjacent',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'A shoulder sits beside the anchor lane.',
  },
  {
    key: 'is_one_way',
    type: 'boolean',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'No opposing lanes in the anchor lane row.',
  },
  {
    key: 'road_name',
    type: 'string',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Display name of the road at the anchor. Never a placement reference.',
  },
  {
    key: 'segment_length_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Length of the parent lane chain, metres.',
  },
  {
    key: 'runway_upstream_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Road available behind the location along its own corridor, metres.',
  },
  {
    key: 'runway_downstream_m',
    type: 'number',
    scope: 'always',
    producedBy: 'densify/midblock-segments',
    description: 'Road available ahead of the location along its own corridor, metres.',
  },
  {
    key: 'usable_length_m',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/work-zones',
    description: 'Contiguous length meeting all work-zone criteria, metres.',
  },
  {
    key: 'grade_pct',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/work-zones (from the search index road profile)',
    description: 'Longitudinal grade at the location, percent.',
  },
  {
    key: 'exit_road_name',
    type: 'string',
    // Conditional, because its producer is conditional: junction-movements
    // writes this key only `if (exitRoad)`, and a road only has a name when the
    // search index, a street-name sign, or an authored road-name table supplied
    // one. Every hand-built map happened to carry names, so declaring it
    // `always` never fired — until an uploaded map arrived with unnamed roads
    // and failed a whole catalog build over a display-only string.
    scope: 'conditional',
    producedBy: 'densify/junction-movements',
    description: 'Road the movement exits onto. Display only.',
  },

  // --- parking_space ---
  {
    key: 'entry_heading_deg',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/parking-spaces',
    description: 'Compass bearing from the bay centre toward its entry position.',
  },
  {
    key: 'stall_length_m',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/parking-spaces',
    description: 'Longer side of the bay polygon, metres.',
  },
  {
    key: 'stall_width_m',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/parking-spaces',
    description: 'Shorter side of the bay polygon, metres.',
  },
  {
    key: 'is_parallel_parking',
    type: 'boolean',
    scope: 'conditional',
    producedBy: 'densify/parking-spaces',
    description: 'Bay long axis is within 30° of the adjacent lane heading.',
  },

  // --- school_zone ---
  {
    key: 'school_sign_count',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/school-zones',
    description: 'Number of MUTCD school signs projected into this zone.',
  },
  {
    key: 'school_sign_codes',
    type: 'string[]',
    scope: 'conditional',
    producedBy: 'densify/school-zones',
    description: 'Sorted, de-duplicated MUTCD codes (S1-1, S4-2P, ...).',
  },
  {
    key: 'zone_length_m',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/school-zones',
    description: 'Along-road extent of the school zone, metres.',
  },

  // --- building_entrance ---
  {
    key: 'address_formatted',
    type: 'string',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'Full postal address of the entrance. Display only.',
  },
  {
    key: 'street_name',
    type: 'string',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'Road the entrance was snapped to. Display only.',
  },
  {
    key: 'road_access_distance_m',
    type: 'number',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'Overture-reported distance from the address point to the road.',
  },
  {
    key: 'building_id',
    type: 'string',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'Overture building this entrance belongs to.',
  },
  {
    key: 'address_number',
    type: 'string',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'House number of the entrance. Feeds the handle ladder.',
  },
  {
    key: 'postcode',
    type: 'string',
    scope: 'conditional',
    producedBy: 'densify/building-entrances',
    description: 'Postcode of the entrance address. Display only.',
  },
];

/** Fast lookup by key. */
export const DECLARED_FACT_KEY_MAP: ReadonlyMap<string, FactKeySpec> = new Map(
  DECLARED_FACT_KEYS.map((s) => [s.key, s]),
);

/** Outcome of the declared-key assertion. */
export interface FactKeyAudit {
  /** Declared `always` keys with no producer in this build. Non-empty ⇒ build fails. */
  missingAlways: string[];
  /** Declared `conditional` keys with no producer in this build. Informational. */
  missingConditional: string[];
  /** Keys present on locations but not declared (adopted from the search index). */
  undeclaredPresent: string[];
  /** Every key actually produced, sorted. */
  produced: string[];
}

/** Which fact keys a set of locations actually carries. */
export function summariseFactKeys(
  locations: readonly { facts: Record<string, unknown> }[],
): FactKeyAudit {
  const produced = new Set<string>();
  for (const loc of locations) for (const key of Object.keys(loc.facts)) produced.add(key);
  const missingAlways: string[] = [];
  const missingConditional: string[] = [];
  for (const spec of DECLARED_FACT_KEYS) {
    if (produced.has(spec.key)) continue;
    if (spec.scope === 'always') missingAlways.push(spec.key);
    else missingConditional.push(spec.key);
  }
  const undeclaredPresent = [...produced].filter((k) => !DECLARED_FACT_KEY_MAP.has(k)).sort();
  return {
    missingAlways: missingAlways.sort(),
    missingConditional: missingConditional.sort(),
    undeclaredPresent,
    produced: [...produced].sort(),
  };
}

/**
 * Throw when a declared `always` key has no producer.
 *
 * Called at the end of every catalog build. Downgrading this to a warning is
 * how the vocabulary rots.
 */
export function assertDeclaredFactsProduced(
  mapId: string,
  locations: readonly { facts: Record<string, unknown> }[],
): FactKeyAudit {
  const audit = summariseFactKeys(locations);
  if (audit.missingAlways.length > 0) {
    throw new Error(
      `map-intel[${mapId}]: declared fact keys with no producer: ${audit.missingAlways.join(', ')}. ` +
        `Either derive them or change their scope in DECLARED_FACT_KEYS.`,
    );
  }
  return audit;
}
