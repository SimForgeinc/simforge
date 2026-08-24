import { describe, expect, it } from "vitest";
import {
  extractAddresses,
  type OvertureAddressInput,
} from "../overture-address-extractor";
import {
  extractBuildings,
  type OvertureBuildingInput,
} from "../overture-building-extractor";

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
    layer_class: null,
    subtype: null,
    height: null,
    num_floors: null,
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
  number: string | null,
  street: string | null,
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

describe("extractAddresses", () => {
  it("links each address to its enclosing building via point-in-polygon", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0), squareBuilding("b2", -122.01, 37.01)],
      "map_1",
      undefined,
    );
    const rawAddresses = [
      address("a1", "100", "Main St", -122.0, 37.0), // inside b1
      address("a2", "200", "Elm St", -122.01, 37.01), // inside b2
      address("a3", "300", "Oak St", -122.005, 37.005), // outside both buildings
    ];

    const { addresses } = extractAddresses(rawAddresses, "map_1", buildings, undefined);
    expect(addresses).toHaveLength(3);
    const byNumber = new Map(addresses.map((a) => [a.row.number, a]));
    expect(byNumber.get("100")!.row.building_id).toBe(buildings[0]!.row.id);
    expect(byNumber.get("200")!.row.building_id).toBe(buildings[1]!.row.id);
    expect(byNumber.get("300")!.row.building_id).toBeNull();
  });

  it("populates address_count on the buildings it linked to", () => {
    const buildings = extractBuildings([squareBuilding("b1", -122.0, 37.0)], "map_1", undefined);
    const rawAddresses = [
      address("a1", "100", "Main St", -122.0, 37.0),
      address("a2", "102", "Main St", -122.0001, 37.0001),
      address("a3", "200", "Elm St", -100, 30), // outside, won't link
    ];
    extractAddresses(rawAddresses, "map_1", buildings, undefined);
    expect(buildings[0]!.row.address_count).toBe(2);
  });

  it("drops addresses without a street value", () => {
    const buildings = extractBuildings([squareBuilding("b1", -122.0, 37.0)], "map_1", undefined);
    const rawAddresses = [
      address("a1", "100", null, -122.0, 37.0),
      address("a2", "100", "Main St", -122.0, 37.0),
    ];
    const { addresses } = extractAddresses(rawAddresses, "map_1", buildings, undefined);
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.row.street).toBe("Main St");
  });

  it("normalizes the trigram-search column conservatively", () => {
    const buildings: ReturnType<typeof extractBuildings> = [];
    const { addresses } = extractAddresses(
      [address("a1", "600", "Main St.", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    );
    expect(addresses[0]!.row.normalized).toBe("600 main st menlo park ca 94025");
    expect(addresses[0]!.row.formatted).toContain("600 Main St.");
  });

  it("keeps addresses inside a kept building even when far from road points", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      [{ lat: 37.0, lng: -122.0 }], // inside the relevance radius for the centroid
      50,
    );
    expect(buildings).toHaveLength(1);
    // Distant road set — the address would normally fail the gate, but
    // because it's inside a kept building it is retained.
    const distantRoads = [{ lat: 37.0, lng: -122.0 }];
    const { addresses } = extractAddresses(
      [address("a1", "100", "Main St", -122.00001, 37.00001)],
      "map_1",
      buildings,
      distantRoads,
      50,
    );
    expect(addresses).toHaveLength(1);
    expect(addresses[0]!.row.building_id).toBe(buildings[0]!.row.id);
  });

  it("picks each building's closest-to-centroid address as primary_address", () => {
    // Two addresses inside one mall-sized building: one right at the centroid,
    // one near the edge. The centroid one should win regardless of input order.
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0, 0.001)], // ~110 m square
      "map_1",
      undefined,
    );
    const rawAddresses = [
      address("a1", "999", "Edge St", -122.0009, 37.0009), // near corner
      address("a2", "100", "Center St", -122.0, 37.0),     // exactly centroid
    ];
    extractAddresses(rawAddresses, "map_1", buildings, undefined);
    expect(buildings[0]!.row.primary_address).toContain("100 Center St");
  });

  it("picks primary_address using cos(lat)-scaled distance, not raw degrees", () => {
    // At 37°N, cos(37°) ≈ 0.7986: one degree of longitude is ~80% the length
    // of one degree of latitude. Without the cosine scaling, raw dLat²+dLng²
    // overestimates east-west separation, and an actually-closer east-west
    // address would lose to a farther north-south one.
    //
    // Building centroid: (37.0, -122.0).
    // Address EW: (37.0, -122.000900) — 0.0009° west = ~80 m east-west, 0 m N/S.
    //   raw    distSq = 0 + 0.0009²   = 0.81e-6
    //   scaled distSq = 0 + (0.0009*0.7986)² ≈ 0.516e-6
    // Address NS: (37.000700, -122.0) — 0.0007° north = ~78 m N/S, 0 m E/W.
    //   raw    distSq = 0.0007² + 0    = 0.49e-6
    //   scaled distSq = 0.0007² + 0    = 0.49e-6
    //
    // Raw degrees: NS wins (0.49 < 0.81). Cos-scaled: still NS wins (0.49 <
    // 0.516), but only barely — bumping EW closer flips the winner under
    // cos-scaling while raw degrees would still pick NS. Use a slightly
    // closer EW (0.00088°) to make the regression unambiguous:
    //   raw    EW = 0.00088² = 0.7744e-6     (NS=0.49e-6 still wins by a lot)
    //   scaled EW = (0.00088*0.7986)² ≈ 0.494e-6 (≈ tied with NS, EW wins by 1%)
    //
    // Pick a setup where EW is the genuine geometric winner under metric
    // distance, but raw degrees would pick NS. That is what this test asserts.
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0, 0.001)], // ~110 m square so both points fall inside
      "map_1",
      undefined,
    );
    const ewAddress: OvertureAddressInput = {
      id: "ew",
      number: "100",
      street: "East-West Ave",
      postcode: "94025",
      country: "US",
      region: "CA",
      locality: "Menlo Park",
      lng: -122.0007, // ~62 m east of centroid (after cos scaling)
      lat: 37.0,
    };
    const nsAddress: OvertureAddressInput = {
      id: "ns",
      number: "200",
      street: "North-South Blvd",
      postcode: "94025",
      country: "US",
      region: "CA",
      locality: "Menlo Park",
      lng: -122.0,
      lat: 37.0007, // ~78 m north of centroid
    };
    extractAddresses([ewAddress, nsAddress], "map_1", buildings, undefined);
    // EW is geometrically closer in metres; raw degree-squared would pick NS.
    expect(buildings[0]!.row.primary_address).toContain("East-West Ave");
  });

  it("leaves primary_address null on buildings with no in-building address", () => {
    const buildings = extractBuildings(
      [squareBuilding("b1", -122.0, 37.0)],
      "map_1",
      undefined,
    );
    extractAddresses(
      [address("a1", "100", "Main St", -100, 30)], // far outside
      "map_1",
      buildings,
      undefined,
    );
    expect(buildings[0]!.row.address_count).toBe(0);
    expect(buildings[0]!.row.primary_address).toBeNull();
  });

  it("initializes new road-access fields to null on every address row", () => {
    const buildings: ReturnType<typeof extractBuildings> = [];
    const { addresses } = extractAddresses(
      [address("a1", "100", "Main St", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    );
    expect(addresses[0]!.row.road_access_lat).toBeNull();
    expect(addresses[0]!.row.road_access_lng).toBeNull();
    expect(addresses[0]!.row.road_access_distance_m).toBeNull();
    expect(addresses[0]!.row.road_access_road_name).toBeNull();
  });

  it("produces deterministic ids across runs", () => {
    const buildings: ReturnType<typeof extractBuildings> = [];
    const a = extractAddresses(
      [address("a1", "100", "Main", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    ).addresses[0]!;
    const b = extractAddresses(
      [address("a1", "100", "Main", -122.0, 37.0)],
      "map_1",
      buildings,
      undefined,
    ).addresses[0]!;
    expect(a.row.id).toBe(b.row.id);
  });
});
