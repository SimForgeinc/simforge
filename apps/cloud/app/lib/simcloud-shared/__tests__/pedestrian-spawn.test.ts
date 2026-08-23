import { describe, it, expect } from "vitest";
import {
  isPedestrianSpawnCandidate,
  PEDESTRIAN_SPAWN_KINDS,
  PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES,
} from "../enrichment/pedestrian-spawn";
import type {
  CandidateLocation,
  CandidateLocationKind,
} from "../map-candidate-location";

function makeCandidate(
  kind: CandidateLocationKind,
  evidencePrimitives: Record<string, string | number | boolean> = {},
): CandidateLocation {
  return {
    id: `cand-${kind}`,
    map_asset_id: "asset-001",
    kind,
    source: "manual",
    label: `${kind} candidate`,
    reason: "test",
    confidence: 0.8,
    tags: [],
    evidence: [
      {
        detectorId: "test-detector",
        detectorVersion: "1",
        primitives: evidencePrimitives,
        confidence: 0.8,
        matchedTags: [],
        explanation: "test",
      },
    ],
    region: { type: "Point", coordinates: [0, 0] },
    center: { lat: 0, lng: 0 },
  };
}

describe("isPedestrianSpawnCandidate", () => {
  it.each([...PEDESTRIAN_SPAWN_KINDS].map((kind) => ({ kind })))(
    "returns true for kind=$kind",
    ({ kind }) => {
      expect(isPedestrianSpawnCandidate(makeCandidate(kind))).toBe(true);
    },
  );

  it("returns true for occlusion candidates whose subtype is in the pedestrian-spawn set", () => {
    for (const subtype of PEDESTRIAN_SPAWN_OCCLUSION_SUBTYPES) {
      const candidate = makeCandidate("occlusion", { occlusion_subtype: subtype });
      expect(
        isPedestrianSpawnCandidate(candidate),
        `expected occlusion subtype=${subtype} to qualify`,
      ).toBe(true);
    }
  });

  it("returns false for vehicle-visibility-only occlusion subtypes", () => {
    // CURVE / CREST / NARROW_BUILDING_CORRIDOR describe sightline
    // geometry, not pedestrian density. They should not be silently
    // promoted to pedestrian spawns even though they share the
    // `occlusion` candidate kind.
    for (const subtype of ["CURVE_OCCLUSION", "CREST_OCCLUSION", "NARROW_BUILDING_CORRIDOR"]) {
      const candidate = makeCandidate("occlusion", { occlusion_subtype: subtype });
      expect(
        isPedestrianSpawnCandidate(candidate),
        `expected occlusion subtype=${subtype} to NOT qualify`,
      ).toBe(false);
    }
  });

  it("returns false for kinds intentionally excluded from the set", () => {
    // Adjacency-derived kinds (junction, road_segment) get
    // `pedestrian_spawn` from the sidecar's graph-adjacency pass, not
    // from this function. AV collision points depend on the specific
    // collision and are likewise not auto-promoted here.
    for (const kind of ["junction", "road_segment", "av_collision_point"] as const) {
      expect(isPedestrianSpawnCandidate(makeCandidate(kind))).toBe(false);
    }
  });

  it("returns false for occlusion candidates with no recorded subtype", () => {
    const candidate = makeCandidate("occlusion", {});
    expect(isPedestrianSpawnCandidate(candidate)).toBe(false);
  });
});
