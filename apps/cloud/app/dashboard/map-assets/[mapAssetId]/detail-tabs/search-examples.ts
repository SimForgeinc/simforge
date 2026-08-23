/**
 * Curated example queries surfaced in the map search UI.
 *
 * Consumed by `SearchExamplesPanel` — the empty-state chips below the input,
 * one click runs the query. Keep the list short and aspirational. Each entry
 * has an explicit `tier` so the UI can show Phase B/C examples as "coming
 * soon" before the query paths actually resolve — advertising the roadmap
 * as part of the product.
 *
 * Ordering: the most expressive queries (scenarios, topology, affordances)
 * come first so users see the scenario-reasoning vocabulary before the
 * simpler feature-presence queries. The plain-fact groups still live below
 * them as a reference catalog for when a targeted single-attribute query is
 * what you actually want.
 */

export type SearchExampleTier = "available" | "coming_soon";

export interface SearchExample {
  /** Display text on the chip / line item. */
  label: string;
  /** Query that gets submitted when the chip is clicked. */
  query: string;
  tier: SearchExampleTier;
}

export interface SearchExampleGroup {
  id: string;
  title: string;
  description: string;
  tier: SearchExampleTier;
  examples: SearchExample[];
}

export const SEARCH_EXAMPLE_GROUPS: SearchExampleGroup[] = [
  {
    id: "scenarios",
    title: "Scenario intent",
    description:
      "Combined queries that exercise the full stack — affordances, topology, and proximity in one shot. These are the shapes AV scenario generation cares about.",
    tier: "available",
    examples: [
      {
        label: "parking exit into arterial",
        query: "parking exit into arterial",
        tier: "available",
      },
      {
        label: "steep road leading to intersection",
        query: "steep road leading to intersection",
        tier: "available",
      },
      {
        label: "bus stop leading to signalized junction",
        query: "bus stop leading to signalized junction",
        tier: "available",
      },
      {
        label: "parking lot connected to arterial",
        query: "parking lot connected to arterial",
        tier: "available",
      },
      {
        label: "school near uncontrolled junction",
        query: "school near uncontrolled junction",
        tier: "available",
      },
      {
        label: "parking near crosswalk",
        query: "parking near crosswalk",
        tier: "available",
      },
    ],
  },
  {
    id: "topology",
    title: "Leading to / coming from",
    description:
      "Follow the road network — find what feeds into (or out of) a place. Bounded at 250 m by default; append `within Xm` to widen up to 1500 m.",
    tier: "available",
    examples: [
      {
        label: "road leading to signalized junction",
        query: "road leading to signalized junction",
        tier: "available",
      },
      {
        label: "school before signalized junction",
        query: "school before signalized junction",
        tier: "available",
      },
      {
        label: "crosswalk after school",
        query: "crosswalk after school",
        tier: "available",
      },
      {
        label: "intersection connected to school",
        query: "intersection connected to school",
        tier: "available",
      },
      {
        label: "bike lane leading to crosswalk",
        query: "bike lane leading to crosswalk",
        tier: "available",
      },
    ],
  },
  {
    id: "affordances",
    title: "Scenario affordances",
    description:
      "Filter on derived scenario properties — road hierarchy, spawn zones, maneuver candidates, lot egress.",
    tier: "available",
    examples: [
      { label: "arterial road", query: "arterial road", tier: "available" },
      { label: "local road", query: "local road", tier: "available" },
      { label: "parking exit", query: "parking exit", tier: "available" },
      {
        label: "unprotected left",
        query: "unprotected left",
        tier: "available",
      },
      {
        label: "pedestrian spawn",
        query: "pedestrian spawn",
        tier: "available",
      },
      { label: "cyclist spawn", query: "cyclist spawn", tier: "available" },
    ],
  },
  {
    id: "proximity",
    title: "Near something",
    description: "Combine two object families with a distance relation.",
    tier: "available",
    examples: [
      {
        label: "bike lane near school",
        query: "bike lane near school",
        tier: "available",
      },
      {
        label: "bus stop adjacent to crosswalk",
        query: "bus stop adjacent to crosswalk",
        tier: "available",
      },
      {
        label: "bus stop near T intersection",
        query: "bus stop near uncontrolled T intersection",
        tier: "available",
      },
      {
        label: "parking lot near hospital",
        query: "parking lot near hospital",
        tier: "available",
      },
      {
        label: "gas station within 50m of junction",
        query: "gas station within 50m of signalized junction",
        tier: "available",
      },
    ],
  },
  {
    id: "named",
    title: "On a specific road",
    description:
      "Combine an object filter with a street name — the street name falls through as free-text against the object's resolved label. Wrap multi-word names in double quotes so every token of the name has to match together.",
    tier: "available",
    examples: [
      {
        label: 'parking lots on "Page Mill Road"',
        query: 'parking lots on "Page Mill Road"',
        tier: "available",
      },
      {
        label: 'crosswalks on "Hanover Street"',
        query: 'crosswalks on "Hanover Street"',
        tier: "available",
      },
      {
        label: 'bus stop on "Foothill Expressway"',
        query: 'bus stop on "Foothill Expressway"',
        tier: "available",
      },
      {
        label: "parking lots on Main Street",
        query: "parking lots on Main Street",
        tier: "available",
      },
      {
        label: "bus stop at MLK @ 2nd Street",
        query: "bus stop at MLK Avenue at 2nd Street",
        tier: "available",
      },
    ],
  },
  {
    id: "junctions",
    title: "Junctions",
    description:
      "Filter intersections by leg count, control type, footprint size, and geometry class.",
    tier: "available",
    examples: [
      { label: "4-way junctions", query: "4-way junctions", tier: "available" },
      { label: "signalized", query: "signalized junction", tier: "available" },
      { label: "T intersections", query: "T-intersection", tier: "available" },
      { label: "all-way stop", query: "all-way stop", tier: "available" },
      {
        label: "complex multi-leg",
        query: "complex multi-leg junction",
        tier: "available",
      },
      {
        label: "large intersections",
        query: "large intersection",
        tier: "available",
      },
      {
        label: "small junctions",
        query: "small junction",
        tier: "available",
      },
      {
        label: "bike-lane-adjacent intersection",
        query: "bike-lane-adjacent intersection",
        tier: "available",
      },
    ],
  },
  {
    id: "streets",
    title: "Streets",
    description:
      "Speed, grade, curvature, width, and pedestrian/bike infrastructure.",
    tier: "available",
    examples: [
      { label: "steep hills", query: "steep hill", tier: "available" },
      { label: "bike lanes", query: "bike lane", tier: "available" },
      { label: "high-speed", query: "high-speed road", tier: "available" },
      { label: "sharp curves", query: "sharp curve", tier: "available" },
      { label: "sidewalks", query: "sidewalk", tier: "available" },
      { label: "narrow streets", query: "narrow street", tier: "available" },
      { label: "wide roads", query: "wide road", tier: "available" },
      {
        label: "two-sided parking",
        query: "parking on both sides",
        tier: "available",
      },
      {
        label: "crest visibility risk",
        query: "crest elevation change",
        tier: "available",
      },
    ],
  },
  {
    id: "parking",
    title: "Parking",
    description: "Filter parking lots by size and access type.",
    tier: "available",
    examples: [
      {
        label: "large parking lot",
        query: "large parking lot",
        tier: "available",
      },
      {
        label: "small parking lot",
        query: "small parking lot",
        tier: "available",
      },
      {
        label: "curb parking",
        query: "curb parking",
        tier: "available",
      },
    ],
  },
  {
    id: "pois",
    title: "Points of interest",
    description: "Schools, hospitals, bus stops, gas stations — anchored to a road.",
    tier: "available",
    examples: [
      { label: "bus stops", query: "bus stop", tier: "available" },
      {
        label: "school frontages",
        query: "school frontage",
        tier: "available",
      },
      {
        label: "hospital approaches",
        query: "hospital approach",
        tier: "available",
      },
      {
        label: "gas stations",
        query: "gas station",
        tier: "available",
      },
      { label: "crosswalks", query: "crosswalks", tier: "available" },
      {
        label: "pedestrian crossings",
        query: "pedestrian crossings",
        tier: "available",
      },
    ],
  },
  {
    id: "categories",
    title: "Commercial categories",
    description:
      "Wider Overture POI taxonomy — retail, food, lodging, transportation hubs. Available wherever the map's enrichment snapshot covers them.",
    tier: "available",
    examples: [
      { label: "retail", query: "retail", tier: "available" },
      { label: "restaurants", query: "restaurant", tier: "available" },
      { label: "hotels", query: "hotel", tier: "available" },
      { label: "shopping malls", query: "shopping mall", tier: "available" },
      { label: "airports", query: "airport", tier: "available" },
      { label: "transit stops", query: "transit stop", tier: "available" },
      { label: "train stations", query: "train station", tier: "available" },
    ],
  },
];

/** Flatter list for the empty-state panel — top picks per group. */
export function getFeaturedExamples(): SearchExample[] {
  const featured: SearchExample[] = [];
  for (const group of SEARCH_EXAMPLE_GROUPS) {
    // 2 featured per group → a mix of tiers so "coming soon" lives alongside
    // "available" rather than being ghettoized at the bottom.
    featured.push(...group.examples.slice(0, 2));
  }
  return featured;
}
