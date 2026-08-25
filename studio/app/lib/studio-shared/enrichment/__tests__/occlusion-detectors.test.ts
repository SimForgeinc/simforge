import { describe, expect, it } from "vitest";
import {
  CandidateLocationSchema,
  type CandidateLocation,
  type OcclusionSubtype,
} from "../../map-candidate-location";
import {
  parseElevationProfile,
  sampleElevation,
} from "../xodr-geometry";
import { detectCurveOcclusion } from "../occlusion/detect-curve";
import { detectCrestOcclusion } from "../occlusion/detect-crest";
import { detectParkingNearConflict } from "../occlusion/detect-parking-near-conflict";
import { detectNarrowBuildingCorridor } from "../occlusion/detect-narrow-corridor";
import { detectCommercialDeliveryOcclusion } from "../occlusion/detect-commercial-delivery";
import { detectBusStopOcclusion } from "../occlusion/detect-bus-stop";
import { dedupeBySubtype } from "../occlusion/cluster";
import { runMetadataPhaseOcclusion } from "../occlusion";

const ORIGIN = { originLat: 37.4, originLon: -122.1 };

function xodrLine(roadId: string, length: number, hdg = 0): string {
  return `<road id="${roadId}" length="${length}">
    <planView>
      <geometry s="0" x="0" y="0" hdg="${hdg}" length="${length}"><line/></geometry>
    </planView>
    <lanes>
      <laneSection s="0">
        <left><lane id="1" type="driving"/></left>
        <right><lane id="-1" type="driving"/></right>
      </laneSection>
    </lanes>
  </road>`;
}

function xodrSharpCurve(): string {
  // A 60 m arc with curvature 0.04 (radius 25 m) — well above the 0.02 sharp
  // threshold and long enough to satisfy the 15 m minimum.
  return `<OpenDRIVE>
    <road id="100" length="60">
      <planView>
        <geometry s="0" x="0" y="0" hdg="0" length="60">
          <arc curvature="0.04"/>
        </geometry>
      </planView>
      <lanes>
        <laneSection s="0">
          <left><lane id="1" type="driving"/></left>
          <right><lane id="-1" type="driving"/></right>
        </laneSection>
      </lanes>
    </road>
  </OpenDRIVE>`;
}

function xodrShallowCurve(): string {
  return `<OpenDRIVE>
    <road id="200" length="60">
      <planView>
        <geometry s="0" x="0" y="0" hdg="0" length="60">
          <arc curvature="0.001"/>
        </geometry>
      </planView>
      <lanes>
        <laneSection s="0">
          <left><lane id="1" type="driving"/></left>
          <right><lane id="-1" type="driving"/></right>
        </laneSection>
      </lanes>
    </road>
  </OpenDRIVE>`;
}

function xodrCrestRoad(): string {
  // 200 m road with two elevation segments forming a hill: rises from 0 to ~4 m
  // at s=100, then falls back. The second polynomial uses a coefficient so the
  // crest derivative crosses zero around the join.
  return `<OpenDRIVE>
    <road id="300" length="200">
      <planView>
        <geometry s="0" x="0" y="0" hdg="0" length="200"><line/></geometry>
      </planView>
      <elevationProfile>
        <elevation s="0" a="0" b="0.04" c="-0.0004" d="0"/>
        <elevation s="100" a="2" b="-0.04" c="0" d="0"/>
      </elevationProfile>
      <lanes>
        <laneSection s="0">
          <left><lane id="1" type="driving"/></left>
          <right><lane id="-1" type="driving"/></right>
        </laneSection>
      </lanes>
    </road>
  </OpenDRIVE>`;
}

function getPrimitive(
  c: CandidateLocation,
  key: string,
): number | boolean | string | undefined {
  for (const ev of c.evidence) {
    const v = ev.primitives[key];
    if (v !== undefined) return v;
  }
  return undefined;
}

function expectValidOcclusionCandidate(
  c: unknown,
  subtype: OcclusionSubtype,
): void {
  const parsed = CandidateLocationSchema.parse(c);
  expect(parsed.kind).toBe("occlusion");
  expect(getPrimitive(parsed, "occlusion_subtype")).toBe(subtype);
  expect(parsed.confidence).toBeGreaterThan(0);
  expect(parsed.confidence).toBeLessThanOrEqual(1);
  expect(parsed.scenarioTags?.length ?? 0).toBeGreaterThan(0);
}

describe("XODR elevation profile parser", () => {
  it("parses cubic <elevation> records and evaluates them at sample points", () => {
    const body = `
      <elevation s="0" a="1" b="0.5" c="0" d="0"/>
      <elevation s="10" a="6" b="-0.1" c="0.01" d="0"/>
    `;
    const profile = parseElevationProfile(body);
    expect(profile).toHaveLength(2);
    // First segment: z(5) = 1 + 0.5*5 = 3.5
    expect(sampleElevation(profile, 5)).toBeCloseTo(3.5, 6);
    // Second segment: z at s=15 → ds=5, 6 + (-0.1)*5 + 0.01*25 = 5.75
    expect(sampleElevation(profile, 15)).toBeCloseTo(5.75, 6);
  });

  it("returns 0 for empty profiles", () => {
    expect(sampleElevation([], 100)).toBe(0);
  });
});

describe("detectCurveOcclusion", () => {
  it("emits a candidate for a sharp arc that satisfies the length threshold", () => {
    const out = detectCurveOcclusion({
      mapAssetId: "m1",
      xodrText: xodrSharpCurve(),
      coordTransform: ORIGIN,
      crosswalks: [],
      junctions: [],
    });
    expect(out).toHaveLength(1);
    expectValidOcclusionCandidate(out[0], "CURVE_OCCLUSION");
    expect(getPrimitive(out[0]!, "high_curvature")).toBe(true);
    expect(getPrimitive(out[0]!, "road_id")).toBe("100");
  });

  it("ignores roads whose curvature is below the sharp threshold", () => {
    const out = detectCurveOcclusion({
      mapAssetId: "m1",
      xodrText: xodrShallowCurve(),
      coordTransform: ORIGIN,
      crosswalks: [],
      junctions: [],
    });
    expect(out).toEqual([]);
  });

  it("boosts confidence when a crosswalk is within 80 m of the curve apex", () => {
    const baseline = detectCurveOcclusion({
      mapAssetId: "m1",
      xodrText: xodrSharpCurve(),
      coordTransform: ORIGIN,
      crosswalks: [],
      junctions: [],
    })[0]!;
    const boosted = detectCurveOcclusion({
      mapAssetId: "m1",
      xodrText: xodrSharpCurve(),
      coordTransform: ORIGIN,
      crosswalks: [{ lat: baseline.center.lat, lng: baseline.center.lng }],
      junctions: [],
    })[0]!;
    expect(boosted.confidence).toBeGreaterThan(baseline.confidence);
    expect(getPrimitive(boosted, "crosswalk_nearby")).toBe(true);
  });
});

describe("detectCrestOcclusion", () => {
  it("emits a candidate at a hill crest with short sight distance", () => {
    const out = detectCrestOcclusion({
      mapAssetId: "m1",
      xodrText: xodrCrestRoad(),
      coordTransform: ORIGIN,
      crosswalks: [],
      junctions: [],
    });
    expect(out.length).toBeGreaterThan(0);
    expectValidOcclusionCandidate(out[0], "CREST_OCCLUSION");
    expect(getPrimitive(out[0]!, "crest_detected")).toBe(true);
  });

  it("ignores roads with no elevation profile", () => {
    const xodr = `<OpenDRIVE>${xodrLine("301", 200)}</OpenDRIVE>`;
    const out = detectCrestOcclusion({
      mapAssetId: "m1",
      xodrText: xodr,
      coordTransform: ORIGIN,
      crosswalks: [],
      junctions: [],
    });
    expect(out).toEqual([]);
  });
});

describe("detectParkingNearConflict", () => {
  it("emits a candidate when a street-parking cluster sits within 30 m of a crosswalk", () => {
    const center = { lat: 37.401, lng: -122.101 };
    const crosswalkCenter = {
      lat: center.lat + 0.0001,
      lng: center.lng + 0.0001,
    }; // ~14 m
    const out = detectParkingNearConflict({
      mapAssetId: "m1",
      parkingClusters: [
        {
          entityId: "pc1",
          kind: "parking_cluster",
          center,
          region: { type: "Point", coordinates: [center.lng, center.lat] },
          provenance: {
            sourceFile: "geojson",
            sourceIds: ["x"],
            extractorVersion: "1.0",
          },
          parkingLaneIds: [],
          totalLengthM: 40,
          isStreetParking: true,
          isLotParking: false,
        } as never,
      ],
      crosswalks: [
        {
          entityId: "cw1",
          kind: "crosswalk",
          center: crosswalkCenter,
          region: {
            type: "Point",
            coordinates: [crosswalkCenter.lng, crosswalkCenter.lat],
          },
          provenance: {
            sourceFile: "xodr",
            sourceIds: ["x"],
            extractorVersion: "1.0",
          },
          isNearJunction: true,
        } as never,
      ],
      junctions: [],
    });
    expect(out).toHaveLength(1);
    expectValidOcclusionCandidate(out[0], "PARKING_NEAR_CONFLICT_POINT");
    expect(getPrimitive(out[0]!, "parking_nearby")).toBe(true);
    expect(getPrimitive(out[0]!, "crosswalk_nearby")).toBe(true);
  });

  it("skips clusters far from any crosswalk or junction", () => {
    const center = { lat: 37.4, lng: -122.1 };
    const out = detectParkingNearConflict({
      mapAssetId: "m1",
      parkingClusters: [
        {
          entityId: "pc1",
          kind: "parking_cluster",
          center,
          region: { type: "Point", coordinates: [center.lng, center.lat] },
          provenance: {
            sourceFile: "geojson",
            sourceIds: ["x"],
            extractorVersion: "1.0",
          },
          parkingLaneIds: [],
          totalLengthM: 40,
          isStreetParking: true,
          isLotParking: false,
        } as never,
      ],
      crosswalks: [],
      junctions: [],
    });
    expect(out).toEqual([]);
  });
});

describe("detectNarrowBuildingCorridor", () => {
  it("emits a candidate when buildings flank a narrow road on both sides", () => {
    // 50 m straight road heading +x; lane count = 2 (driving). Origin at 37.4, -122.1.
    // Buildings on +y side (left) and -y side (right) at ~5 m offset.
    const xodrText = `<OpenDRIVE>${xodrLine("400", 50)}</OpenDRIVE>`;
    const buildings = [
      // left, +5 m in y → +5/111320 deg lat
      { lat: ORIGIN.originLat + 5 / 111320, lng: ORIGIN.originLon + 0.0001, height: 8 },
      { lat: ORIGIN.originLat + 5 / 111320, lng: ORIGIN.originLon + 0.0002, height: 8 },
      { lat: ORIGIN.originLat + 5 / 111320, lng: ORIGIN.originLon + 0.0003, height: 8 },
      // right, -5 m in y
      { lat: ORIGIN.originLat - 5 / 111320, lng: ORIGIN.originLon + 0.0001, height: 8 },
      { lat: ORIGIN.originLat - 5 / 111320, lng: ORIGIN.originLon + 0.0002, height: 8 },
      { lat: ORIGIN.originLat - 5 / 111320, lng: ORIGIN.originLon + 0.0003, height: 8 },
    ];
    const out = detectNarrowBuildingCorridor({
      mapAssetId: "m1",
      xodrText,
      coordTransform: ORIGIN,
      buildings,
    });
    expect(out.length).toBeGreaterThan(0);
    expectValidOcclusionCandidate(out[0], "NARROW_BUILDING_CORRIDOR");
    expect(getPrimitive(out[0]!, "narrow_road")).toBe(true);
  });

  it("does nothing when no XODR is supplied", () => {
    expect(
      detectNarrowBuildingCorridor({
        mapAssetId: "m1",
        xodrText: "",
        coordTransform: ORIGIN,
        buildings: [],
      }),
    ).toEqual([]);
  });
});

describe("detectCommercialDeliveryOcclusion", () => {
  it("emits a candidate when a retail POI sits within 25 m of a crosswalk", () => {
    const out = detectCommercialDeliveryOcclusion({
      mapAssetId: "m1",
      commercialPois: [
        { lat: 37.4, lng: -122.1, type: "retail", name: "Corner Store" },
      ],
      crosswalks: [{ lat: 37.4, lng: -122.0999 }], // ~9 m east
      junctions: [],
    });
    expect(out).toHaveLength(1);
    expectValidOcclusionCandidate(out[0], "COMMERCIAL_DELIVERY_OCCLUSION");
    expect(getPrimitive(out[0]!, "commercial_nearby")).toBe(true);
  });

  it("ignores POIs whose type is neither retail nor restaurant", () => {
    const out = detectCommercialDeliveryOcclusion({
      mapAssetId: "m1",
      commercialPois: [{ lat: 37.4, lng: -122.1, type: "school" }],
      crosswalks: [{ lat: 37.4, lng: -122.0999 }],
      junctions: [],
    });
    expect(out).toEqual([]);
  });
});

describe("detectBusStopOcclusion", () => {
  it("emits a candidate for a bus stop right next to a crosswalk", () => {
    const out = detectBusStopOcclusion({
      mapAssetId: "m1",
      busStops: [{ lat: 37.4, lng: -122.1 }],
      crosswalks: [{ lat: 37.4, lng: -122.09995 }], // ~4-5 m
      junctions: [],
    });
    expect(out).toHaveLength(1);
    expectValidOcclusionCandidate(out[0], "BUS_STOP_OCCLUSION");
    expect(getPrimitive(out[0]!, "bus_stop_nearby")).toBe(true);
  });

  it("ignores isolated bus stops with no crosswalk or junction nearby", () => {
    const out = detectBusStopOcclusion({
      mapAssetId: "m1",
      busStops: [{ lat: 37.4, lng: -122.1 }],
      crosswalks: [{ lat: 38, lng: -122 }],
      junctions: [{ lat: 38, lng: -122 }],
    });
    expect(out).toEqual([]);
  });
});

describe("dedupeBySubtype", () => {
  it("suppresses second candidate of the same subtype within the radius", () => {
    const make = (lat: number, conf: number) => ({
      id: `id_${lat}_${conf}`,
      map_asset_id: "m1",
      kind: "occlusion" as const,
      source: "detector_occlusion_curve" as const,
      label: "x",
      reason: "x",
      confidence: conf,
      tags: ["OCCLUSION_CURVE", "OCCLUSION"],
      evidence: [
        {
          detectorId: "occlusion-curve-detector",
          detectorVersion: "1.0.0",
          primitives: { occlusion_subtype: "CURVE_OCCLUSION" },
          confidence: conf,
          matchedTags: ["OCCLUSION_CURVE", "OCCLUSION"],
          explanation: "x",
        },
      ],
      region: { type: "Point" as const, coordinates: [-122.1, lat] },
      center: { lat, lng: -122.1 },
    });
    const a = make(37.4, 0.7);
    const b = make(37.40005, 0.6); // ~5.5 m north
    const c = make(37.5, 0.6); // far away, kept
    const out = dedupeBySubtype([a, b, c], 10);
    expect(out.map((x) => x.center.lat)).toEqual([37.4, 37.5]);
  });
});

describe("runMetadataPhaseOcclusion", () => {
  it("returns valid CandidateLocations for a simple sharp-curve scene graph", () => {
    const sceneGraph = {
      mapAssetId: "m1",
      computedAt: new Date().toISOString(),
      junctions: [],
      roadSegments: [],
      crosswalks: [],
      parkingClusters: [],
      signals: [],
      signs: [],
    };
    const out = runMetadataPhaseOcclusion({
      mapAssetId: "m1",
      xodrText: xodrSharpCurve(),
      coordTransform: ORIGIN,
      sceneGraph,
    });
    expect(out.length).toBe(1);
    expectValidOcclusionCandidate(out[0], "CURVE_OCCLUSION");
  });
});
