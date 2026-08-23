import { describe, expect, it } from "vitest";
import {
  applyAddressContext,
  copyBuildingRowAddressFieldsToFeature,
} from "../apply-address-context";
import {
  extractBuildings,
  type OvertureBuildingInput,
} from "../overture-building-extractor";
import { extractAddresses, type OvertureAddressInput } from "../overture-address-extractor";
import type { RoadSegmentForMatching } from "../../street-name-resolver";

function squareBuilding(
  id: string,
  lng: number,
  lat: number,
  size = 0.0005,
): OvertureBuildingInput {
  const ring = [
    [lng - size, lat - size],
    [lng + size, lat - size],
    [lng + size, lat + size],
    [lng - size, lat + size],
    [lng - size, lat - size],
  ];
  return {
    id,
    name: `Building ${id}`,
    layer_class: "commercial",
    subtype: null,
    height: 12,
    num_floors: 3,
    centroid_lng: lng,
    centroid_lat: lat,
    min_lng: lng - size,
    min_lat: lat - size,
    max_lng: lng + size,
    max_lat: lat + size,
    geom_json: JSON.stringify({ type: "Polygon", coordinates: [ring] }),
  };
}

function address(
  id: string,
  number: string,
  street: string,
  lng: number,
  lat: number,
): OvertureAddressInput {
  return {
    id,
    number,
    street,
    postcode: "94025",
    country: "US",
    region: "CA",
    locality: "Menlo Park",
    lng,
    lat,
  };
}

function eastWestSegment(name: string, lat: number, lng: number, lengthM = 200): RoadSegmentForMatching {
  const halfDeg = lengthM / 2 / 111_320 / Math.cos((lat * Math.PI) / 180);
  return {
    name,
    road_class: "residential",
    geojson_geometry: JSON.stringify({
      type: "LineString",
      coordinates: [[lng - halfDeg, lat], [lng + halfDeg, lat]],
    }),
    min_lat: lat,
    max_lat: lat,
    min_lng: lng - halfDeg,
    max_lng: lng + halfDeg,
  };
}

describe("applyAddressContext", () => {
  it("mirrors primary_address and address_count onto building features", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      undefined,
    );
    extractAddresses(
      [address("a1", "100", "Main St", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    );

    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [], streetSnapOnlyFeatureCollections: [],
      roadSegments: [],
    });

    const props = buildings[0]!.feature.properties;
    expect(props.primary_address).toContain("100 Main St");
    expect(props.address_count).toBe(1);
  });

  it("attaches building id, name, footprint and address to a POI inside the building", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      undefined,
    );
    extractAddresses(
      [address("a1", "100", "Main St", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    );

    // POI feature simulating a shopping mall point sitting inside the building.
    const mallPoi = {
      type: "Feature",
      id: "p1",
      geometry: { type: "Point", coordinates: [-122.0, 37.0] },
      properties: { id: "p1", layer_id: "shopping_mall", name: "Acme Mall" },
    };
    const collection = { features: [mallPoi] };

    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [collection], streetSnapOnlyFeatureCollections: [],
      roadSegments: [],
    });

    const props = mallPoi.properties as Record<string, unknown>;
    expect(props.building_id).toBe(buildings[0]!.row.id);
    expect(props.building_name).toBe("Building b1");
    expect(props.building_height).toBe(12);
    expect(props.building_num_floors).toBe(3);
    expect(props.address).toContain("100 Main St");
    // POI's geometry is now the building's footprint (Polygon).
    expect((mallPoi.geometry as { type: string }).type).toBe("Polygon");
    // Original Point preserved for label/click anchors.
    expect((props.point_geometry as { type: string }).type).toBe("Point");
  });

  it("does not promote Polygon or LineString features (only Point POIs adopt the footprint)", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      undefined,
    );
    // A LineString that passes through the building — must stay a LineString.
    const lineFeature = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [[-122.0001, 37.0], [-122.0001, 37.00005]],
      },
      properties: {},
    };
    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [{ features: [lineFeature] }], streetSnapOnlyFeatureCollections: [],
      roadSegments: [],
    });
    expect(lineFeature.geometry.type).toBe("LineString");
  });

  it("does NOT inherit building attrs for features in streetSnapOnly bucket", () => {
    // Address feature literally inside the building footprint. It must
    // NOT pick up building_id/building_geometry/etc — addresses are the
    // lookup target the building's primary_address points AT, not the
    // other way around.
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      undefined,
    );
    const addressFeature = {
      type: "Feature",
      id: "addr-1",
      geometry: { type: "Point", coordinates: [-122.0, 37.0] }, // dead center of building
      properties: { id: "addr-1", layer_id: "addresses" },
    };

    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [],
      streetSnapOnlyFeatureCollections: [{ features: [addressFeature] }],
      roadSegments: [],
    });

    const props = addressFeature.properties as Record<string, unknown>;
    expect(props.building_id).toBeUndefined();
    expect(props.building_geometry).toBeUndefined();
    expect(props.address).toBeUndefined();
    // Geometry stays a Point — not promoted to the building footprint.
    expect((addressFeature.geometry as { type: string }).type).toBe("Point");
  });

  it("does not attach building context to POIs outside any building footprint", () => {
    const buildings = extractBuildings([squareBuilding("b1", -122.0, 37.0)], "map_1", undefined);
    const orphanPoi = {
      type: "Feature",
      id: "p1",
      geometry: { type: "Point", coordinates: [-122.5, 37.5] },
      properties: { id: "p1", layer_id: "restaurant" },
    };
    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [{ features: [orphanPoi] }], streetSnapOnlyFeatureCollections: [],
      roadSegments: [],
    });
    expect((orphanPoi.properties as Record<string, unknown>).building_id).toBeUndefined();
  });

  it("snaps every feature (Point, LineString, Polygon) to nearest road and stamps street_name", () => {
    const buildings = extractBuildings([squareBuilding("b1", -122.0, 37.0)], "map_1", undefined);
    const road = eastWestSegment("Main St", 37.0001, -122.0); // ~11 m north of buildings/POIs
    const pointFeature = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [-122.0001, 37.0] },
      properties: {},
    };
    const lineFeature = {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [[-122.0001, 37.0], [-122.0, 37.0], [-121.9999, 37.0]],
      },
      properties: {},
    };
    const polygonFeature = {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-122.0001, 36.9999],
          [-121.9999, 36.9999],
          [-121.9999, 37.0001],
          [-122.0001, 37.0001],
          [-122.0001, 36.9999],
        ]],
      },
      properties: {},
    };

    applyAddressContext({
      buildings,
      buildingHostedFeatureCollections: [{ features: [pointFeature, lineFeature, polygonFeature] }], streetSnapOnlyFeatureCollections: [],
      roadSegments: [road],
    });

    for (const f of [pointFeature, lineFeature, polygonFeature]) {
      const p = f.properties as Record<string, unknown>;
      expect(p.street_name).toBe("Main St");
      expect(typeof p.road_access_lat).toBe("number");
      expect(typeof p.road_access_distance_m).toBe("number");
    }

    // Building feature also gets the snap.
    const buildingProps = buildings[0]!.feature.properties;
    expect(buildingProps.street_name).toBe("Main St");
  });

  it("is a no-op when buildings, features and roadSegments are all empty", () => {
    expect(() =>
      applyAddressContext({ buildings: [], buildingHostedFeatureCollections: [], streetSnapOnlyFeatureCollections: [], roadSegments: [] }),
    ).not.toThrow();
  });

  it("copyBuildingRowAddressFieldsToFeature handles missing properties object", () => {
    const buildings = extractBuildings([squareBuilding("b1", -122.0, 37.0)], "map_1", undefined);
    const b = buildings[0]!;
    b.row.primary_address = "100 Main St";
    b.row.address_count = 4;
    // simulate missing properties (defensive — extractor always allocates one,
    // but downstream code might delete it)
    (b.feature as { properties: Record<string, unknown> | null }).properties = null;
    copyBuildingRowAddressFieldsToFeature(b);
    expect(b.feature.properties.primary_address).toBe("100 Main St");
    expect(b.feature.properties.address_count).toBe(4);
  });
});
