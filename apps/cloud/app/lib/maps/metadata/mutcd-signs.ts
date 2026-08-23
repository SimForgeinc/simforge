/**
 * MUTCD (Manual on Uniform Traffic Control Devices) sign reference table.
 *
 * Maps MUTCD sign codes to human-readable descriptions, signal categories,
 * and sign groups. Used to enrich XODR signal features with descriptive
 * metadata during parsing.
 *
 * Reference: MUTCD 11th Edition (FHWA)
 * RoadRunner exports signs with names like "Sign_R1-1", "Sign_R2-1(35)", etc.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MutcdSignInfo = {
  /** MUTCD code, e.g. "R1-1" */
  code: string;
  /** Human-readable description, e.g. "Stop" */
  description: string;
  /** signal_category value used in our system */
  category: string;
  /** High-level group: regulatory, warning, school, guide */
  group: "regulatory" | "warning" | "school" | "guide";
};

export type MutcdLookupResult = {
  info: MutcdSignInfo;
  /** For speed limit signs (R2-1, R2-2): the speed value in MPH, if present */
  speedLimitMph?: number;
};

// ---------------------------------------------------------------------------
// MUTCD Sign Database
// ---------------------------------------------------------------------------

/**
 * MUTCD sign codes → metadata.
 * Keys are uppercase MUTCD codes (e.g. "R1-1").
 */
export const MUTCD_SIGNS: Record<string, MutcdSignInfo> = {
  // ── Regulatory: Stop & Yield (R1) ──────────────────────────────────────
  "R1-1":  { code: "R1-1",  description: "Stop",                          category: "stop_sign",             group: "regulatory" },
  "R1-2":  { code: "R1-2",  description: "Yield",                         category: "yield_sign",            group: "regulatory" },
  "R1-3P": { code: "R1-3P", description: "Stop — All Way (plaque)",       category: "stop_sign",             group: "regulatory" },
  "R1-5":  { code: "R1-5",  description: "Yield to Pedestrians",          category: "yield_sign",            group: "regulatory" },
  "R1-5A": { code: "R1-5A", description: "Yield Here to Pedestrians",     category: "yield_sign",            group: "regulatory" },

  // ── Regulatory: Speed (R2) ─────────────────────────────────────────────
  "R2-1":  { code: "R2-1",  description: "Speed Limit",                   category: "speed_limit_sign",      group: "regulatory" },
  "R2-2":  { code: "R2-2",  description: "Night Speed Limit",             category: "speed_limit_sign",      group: "regulatory" },
  "R2-2P": { code: "R2-2P", description: "Night Speed Limit (plaque)",    category: "speed_limit_sign",      group: "regulatory" },

  // ── Regulatory: Turn Restrictions (R3) ─────────────────────────────────
  "R3-1":  { code: "R3-1",  description: "No Right Turn",                 category: "turn_restriction_sign", group: "regulatory" },
  "R3-2":  { code: "R3-2",  description: "No Left Turn",                  category: "turn_restriction_sign", group: "regulatory" },
  "R3-3":  { code: "R3-3",  description: "No Turns",                      category: "turn_restriction_sign", group: "regulatory" },
  "R3-4":  { code: "R3-4",  description: "No U-Turn",                     category: "turn_restriction_sign", group: "regulatory" },
  "R3-5":  { code: "R3-5",  description: "No Left or U-Turn",             category: "turn_restriction_sign", group: "regulatory" },
  "R3-7R": { code: "R3-7R", description: "Right Turn Only",               category: "turn_restriction_sign", group: "regulatory" },
  "R3-7L": { code: "R3-7L", description: "Left Turn Only",                category: "turn_restriction_sign", group: "regulatory" },
  "R3-8":  { code: "R3-8",  description: "Right Turn or Straight Only",   category: "turn_restriction_sign", group: "regulatory" },
  "R3-18": { code: "R3-18", description: "No Turn on Red",                category: "turn_restriction_sign", group: "regulatory" },

  // ── Regulatory: Movement (R4) ──────────────────────────────────────────
  "R4-1":  { code: "R4-1",  description: "Do Not Pass",                   category: "regulatory_sign",       group: "regulatory" },
  "R4-7":  { code: "R4-7",  description: "Keep Right",                    category: "regulatory_sign",       group: "regulatory" },
  "R4-7A": { code: "R4-7A", description: "Keep Right (graphic)",          category: "regulatory_sign",       group: "regulatory" },
  "R4-7C": { code: "R4-7C", description: "Keep Right (graphic, alt)",     category: "regulatory_sign",       group: "regulatory" },
  "R4-8":  { code: "R4-8",  description: "Keep Left",                     category: "regulatory_sign",       group: "regulatory" },

  // ── Regulatory: Exclusion (R5) ─────────────────────────────────────────
  "R5-1":  { code: "R5-1",  description: "Do Not Enter",                  category: "regulatory_sign",       group: "regulatory" },
  "R5-1A": { code: "R5-1A", description: "Wrong Way",                     category: "regulatory_sign",       group: "regulatory" },

  // ── Regulatory: One Way / Divided Highway (R6) ─────────────────────────
  "R6-1":  { code: "R6-1",  description: "One Way",                       category: "regulatory_sign",       group: "regulatory" },
  "R6-2":  { code: "R6-2",  description: "One Way (arrow)",               category: "regulatory_sign",       group: "regulatory" },

  // ── Regulatory: Parking (R7) ───────────────────────────────────────────
  "R7-1":  { code: "R7-1",  description: "No Parking Any Time",           category: "parking_sign",          group: "regulatory" },
  "R7-2":  { code: "R7-2",  description: "No Parking (time range)",       category: "parking_sign",          group: "regulatory" },
  "R7-4":  { code: "R7-4",  description: "No Stopping or Standing",       category: "parking_sign",          group: "regulatory" },
  "R7-5":  { code: "R7-5",  description: "Time-Limited Parking",          category: "parking_sign",          group: "regulatory" },
  "R7-6":  { code: "R7-6",  description: "No Parking — Loading Zone",     category: "parking_sign",          group: "regulatory" },
  "R7-8":  { code: "R7-8",  description: "Reserved Parking",              category: "parking_sign",          group: "regulatory" },

  // ── Regulatory: Pedestrian & Bicycle (R9/R10) ──────────────────────────
  "R9-3":  { code: "R9-3",  description: "No Pedestrian Crossing",        category: "regulatory_sign",       group: "regulatory" },
  "R9-7":  { code: "R9-7",  description: "Pedestrian Crossing (symbol)",  category: "regulatory_sign",       group: "regulatory" },
  "R10-1": { code: "R10-1", description: "Turn on Red After Stop",        category: "regulatory_sign",       group: "regulatory" },
  "R10-6": { code: "R10-6", description: "Left Turn Signal",              category: "regulatory_sign",       group: "regulatory" },
  "R10-11":  { code: "R10-11",  description: "Right on Green Arrow Only", category: "regulatory_sign",       group: "regulatory" },
  "R10-11A": { code: "R10-11A", description: "Right on Green Arrow Only", category: "regulatory_sign",       group: "regulatory" },
  "R10-15":  { code: "R10-15",  description: "U-Turn Yield to Right Turn",category: "regulatory_sign",       group: "regulatory" },
  "R10-23":  { code: "R10-23",  description: "Turning Traffic Must Yield", category: "regulatory_sign",      group: "regulatory" },

  // ── Warning: Turns & Curves (W1) ───────────────────────────────────────
  "W1-1":  { code: "W1-1",  description: "Turn Ahead",                    category: "warning_sign",          group: "warning" },
  "W1-2":  { code: "W1-2",  description: "Curve Ahead",                   category: "warning_sign",          group: "warning" },
  "W1-3":  { code: "W1-3",  description: "Reverse Turn",                  category: "warning_sign",          group: "warning" },
  "W1-4":  { code: "W1-4",  description: "Reverse Curve",                 category: "warning_sign",          group: "warning" },
  "W1-5":  { code: "W1-5",  description: "Winding Road",                  category: "warning_sign",          group: "warning" },

  // ── Warning: Intersections (W2) ────────────────────────────────────────
  "W2-1":  { code: "W2-1",  description: "Cross Road Ahead",              category: "warning_sign",          group: "warning" },
  "W2-2":  { code: "W2-2",  description: "Side Road Ahead",               category: "warning_sign",          group: "warning" },
  "W2-3":  { code: "W2-3",  description: "Side Road Ahead (angle)",       category: "warning_sign",          group: "warning" },
  "W2-4":  { code: "W2-4",  description: "T Intersection Ahead",          category: "warning_sign",          group: "warning" },
  "W2-5":  { code: "W2-5",  description: "Y Intersection Ahead",          category: "warning_sign",          group: "warning" },

  // ── Warning: Advance Traffic Control (W3) ──────────────────────────────
  "W3-1":  { code: "W3-1",  description: "Signal Ahead",                  category: "warning_sign",          group: "warning" },
  "W3-2":  { code: "W3-2",  description: "Stop Ahead",                    category: "warning_sign",          group: "warning" },
  "W3-2A": { code: "W3-2A", description: "Signal Ahead",                  category: "warning_sign",          group: "warning" },
  "W3-3":  { code: "W3-3",  description: "Yield Ahead",                   category: "warning_sign",          group: "warning" },

  // ── Warning: Speed (W13) ───────────────────────────────────────────────
  "W13-1": { code: "W13-1", description: "Advisory Speed (curve)",        category: "warning_sign",          group: "warning" },
  "W13-2": { code: "W13-2", description: "Advisory Speed (exit ramp)",    category: "warning_sign",          group: "warning" },
  "W13-3": { code: "W13-3", description: "Advisory Speed (turn)",         category: "warning_sign",          group: "warning" },

  // ── Warning: Pedestrian / Bicycle / School (W11/W15/W16) ──────────────
  "W11-1": { code: "W11-1", description: "Bicycle Crossing",              category: "warning_sign",          group: "warning" },
  "W11-2": { code: "W11-2", description: "Pedestrian Crossing",           category: "warning_sign",          group: "warning" },
  "W11-8": { code: "W11-8", description: "Fire Station Ahead",            category: "warning_sign",          group: "warning" },
  "W15-1": { code: "W15-1", description: "Playground Ahead",              category: "warning_sign",          group: "warning" },
  "W16-7P":  { code: "W16-7P",  description: "Ahead (distance plaque)",   category: "warning_sign",          group: "warning" },
  "W16-9P":  { code: "W16-9P",  description: "Ahead (plaque)",            category: "warning_sign",          group: "warning" },

  // ── Warning: Construction / Work Zone (W20/W21) ────────────────────────
  "W20-1": { code: "W20-1", description: "Road Work Ahead",               category: "warning_sign",          group: "warning" },
  "W20-3": { code: "W20-3", description: "Road Work Next X Miles",        category: "warning_sign",          group: "warning" },
  "W20-4": { code: "W20-4", description: "One Lane Road Ahead",           category: "warning_sign",          group: "warning" },
  "W20-5": { code: "W20-5", description: "Road Closed Ahead",             category: "warning_sign",          group: "warning" },
  "W21-1": { code: "W21-1", description: "Workers Ahead",                 category: "warning_sign",          group: "warning" },

  // ── School (S series) ──────────────────────────────────────────────────
  "S1-1":  { code: "S1-1",  description: "School Area / Advance Warning", category: "school_sign",           group: "school" },
  "S3-1":  { code: "S3-1",  description: "School Speed Limit When Flashing", category: "school_sign",        group: "school" },
  "S4-1P": { code: "S4-1P", description: "School Speed Time Plaque",      category: "school_sign",           group: "school" },
  "S4-2P": { code: "S4-2P", description: "School Speed Days Plaque",      category: "school_sign",           group: "school" },
  "S4-3P": { code: "S4-3P", description: "School Zone Plaque",            category: "school_sign",           group: "school" },
  "S4-4P": { code: "S4-4P", description: "School Time Plaque (alt)",      category: "school_sign",           group: "school" },
  "S4-7P": { code: "S4-7P", description: "All Year Plaque",               category: "school_sign",           group: "school" },
  "S5-2":  { code: "S5-2",  description: "End School Zone",               category: "school_sign",           group: "school" },
};

// ---------------------------------------------------------------------------
// RoadRunner shorthand sign names (non-MUTCD coded)
// ---------------------------------------------------------------------------

/**
 * Maps RoadRunner-specific sign names (case-insensitive, without "Sign_" prefix)
 * to metadata. These are signs that RoadRunner names descriptively rather than
 * using a MUTCD code.
 */
export const RR_SHORTHAND_SIGNS: Record<string, Omit<MutcdSignInfo, "code">> = {
  "nostopping":     { description: "No Stopping",              category: "parking_sign",          group: "regulatory" },
  "bikelane":       { description: "Bike Lane",                category: "other_sign",            group: "regulatory" },
  "leftturn":       { description: "Left Turn Only",           category: "turn_restriction_sign", group: "regulatory" },
  "leftturnou":     { description: "Left Turn, No U-Turn",     category: "turn_restriction_sign", group: "regulatory" },
  "leftturnnou":    { description: "Left Turn, No U-Turn",     category: "turn_restriction_sign", group: "regulatory" },
  "leftturnonuturn":{ description: "Left Turn, No U-Turn",     category: "turn_restriction_sign", group: "regulatory" },
  "leftornturn":    { description: "Left Turn or U-Turn",      category: "turn_restriction_sign", group: "regulatory" },
  "leftoruturn":    { description: "Left Turn or U-Turn",      category: "turn_restriction_sign", group: "regulatory" },
  "roadworkahead":  { description: "Road Work Ahead",          category: "other_sign",            group: "warning" },
};

// ---------------------------------------------------------------------------
// Lookup function
// ---------------------------------------------------------------------------

/** Regex to extract MUTCD code from RoadRunner signal name.
 *  Matches patterns like: Sign_R1-1, Sign_R2-1(35), Sign_W20-1, Sign_R3-7R, Sign_R10-11a
 *  Also matches bare codes: R1-1, R2-1, W20-1 (without Sign_ prefix)
 *  Group 1 = MUTCD code (e.g. "R1-1", "R2-1", "R10-11A")
 *  Group 2 = optional parenthesized value (e.g. "35" from "R2-1(35)")
 */
const MUTCD_CODE_RE = /(?:Sign_)?([A-Z]\d+-\d+[A-Z]?[a-z]?P?)(?:\((\d+)\))?/i;

/** Stricter regex: only matches if the MUTCD code spans the entire string (for bare codes). */
const BARE_MUTCD_CODE_RE = /^([A-Z]\d+-\d+[A-Z]?[a-z]?P?)(?:\((\d+)\))?$/i;

/**
 * Extract MUTCD info from an XODR signal name.
 *
 * Handles:
 * - MUTCD-coded names: "Sign_R1-1", "Sign_R2-1(35)", "Sign_W20-1"
 * - RoadRunner shorthand: "Sign_NoStopping", "Sign_BikeLane", "Sign_LeftTurn"
 *
 * Returns null if the name doesn't match any known pattern.
 */
export function lookupSignInfo(name: string): MutcdLookupResult | null {
  // 1a. Try Sign_-prefixed MUTCD code (e.g. "Sign_R1-1", "Sign_R2-1(35)")
  if (/^Sign_/i.test(name)) {
    const m = MUTCD_CODE_RE.exec(name);
    if (m) {
      const code = m[1]!.toUpperCase();
      const speedVal = m[2] ? Number(m[2]) : undefined;
      const info = MUTCD_SIGNS[code];
      if (info) {
        return { info, speedLimitMph: speedVal };
      }
      // Code extracted but not in our table — return generic info
      return {
        info: {
          code,
          description: `Sign ${code}`,
          category: "other_sign",
          group: "regulatory",
        },
        speedLimitMph: speedVal,
      };
    }
  }

  // 1b. Try bare MUTCD code (e.g. "R1-1", "R2-1", "W20-1")
  const bm = BARE_MUTCD_CODE_RE.exec(name);
  if (bm) {
    const code = bm[1]!.toUpperCase();
    const speedVal = bm[2] ? Number(bm[2]) : undefined;
    const info = MUTCD_SIGNS[code];
    if (info) {
      return { info, speedLimitMph: speedVal };
    }
    return {
      info: {
        code,
        description: `Sign ${code}`,
        category: "other_sign",
        group: "regulatory",
      },
      speedLimitMph: speedVal,
    };
  }

  // 2. Try RoadRunner shorthand (strip "Sign_" prefix)
  const stripped = name.replace(/^Sign_/i, "").toLowerCase();
  if (stripped !== name.toLowerCase()) {
    // Had a Sign_ prefix — check shorthand table
    const shorthand = RR_SHORTHAND_SIGNS[stripped];
    if (shorthand) {
      return {
        info: {
          code: "",
          ...shorthand,
        },
      };
    }
    // Check if it's a turn sign via pattern match
    if (/turn/i.test(stripped)) {
      return {
        info: {
          code: "",
          description: stripped.replace(/([a-z])([A-Z])/g, "$1 $2"),
          category: "turn_restriction_sign",
          group: "regulatory",
        },
      };
    }
  }

  return null;
}
