import { describe, expect, it } from "vitest";
import { attachRoadAccessToAddresses } from "../address-road-access-extractor";
import type { ExtractedAddress } from "../overture-address-extractor";
import type { RoadSegmentForMatching } from "../../street-name-resolver";

function mkAddress(id: string, lat: number, lng: number): ExtractedAddress {
  return {
    row: {
      id,
      map_asset_id: "map_1",
      building_id: null,
      number: null,
      street: "Test St",
      postcode: null,
      formatted: "Test",
      normalized: "test",
      lat,
      lng,
      road_access_lat: null,
      road_access_lng: null,
      road_access_distance_m: null,
      road_access_road_name: null,
    },
    feature: {
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { id, layer_id: "addresses" },
    },
  };
}

/** East-west LineString centered at (lat, lng) with given length in metres. */
function eastWestSegment(
  name: string,
  lat: number,
  lng: number,
  lengthM: number,
  road_class: string | null = "residential",
): RoadSegmentForMatching {
  // 1 metre at the equator ~ 1/111320 degrees of longitude / latitude
  const halfDeg = lengthM / 2 / 111_320 / Math.cos((lat * Math.PI) / 180);
  const a: [number, number] = [lng - halfDeg, lat];
  const b: [number, number] = [lng + halfDeg, lat];
  return {
    name,
    road_class,
    geojson_geometry: JSON.stringify({ type: "LineString", coordinates: [a, b] }),
    min_lat: Math.min(a[1], b[1]),
    max_lat: Math.max(a[1], b[1]),
    min_lng: Math.min(a[0], b[0]),
    max_lng: Math.max(a[0], b[0]),
  };
}

describe("attachRoadAccessToAddresses", () => {
  it("snaps an address onto the closest point of the nearest road segment", () => {
    // Address at (37.0, -122.0). Road runs east-west at lat 37.0001
    // (~11 m north of the address). The snap should land directly above the
    // address (same lng), on the road's lat.
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    const road = eastWestSegment("Main St", 37.0001, -122.0, 200);

    attachRoadAccessToAddresses(addresses, [road]);

    const r = addresses[0]!.row;
    expect(r.road_access_road_name).toBe("Main St");
    expect(r.road_access_lat).toBeCloseTo(37.0001, 5);
    expect(r.road_access_lng).toBeCloseTo(-122.0, 5);
    expect(r.road_access_distance_m).toBeGreaterThan(10);
    expect(r.road_access_distance_m).toBeLessThan(13);
  });

  it("picks the closer of two candidate roads", () => {
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    // 50 m north and 11 m south. South should win.
    const farRoad = eastWestSegment("Far Ave", 37.00045, -122.0, 200);
    const nearRoad = eastWestSegment("Near St", 36.9999, -122.0, 200);

    attachRoadAccessToAddresses(addresses, [farRoad, nearRoad]);
    expect(addresses[0]!.row.road_access_road_name).toBe("Near St");
  });

  it("leaves fields null when no segment is within maxDistanceM", () => {
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    // Road >300 m away, default radius is 250 m.
    const road = eastWestSegment("Distant Blvd", 37.003, -122.0, 200);

    attachRoadAccessToAddresses(addresses, [road]);
    const r = addresses[0]!.row;
    expect(r.road_access_road_name).toBeNull();
    expect(r.road_access_lat).toBeNull();
    expect(r.road_access_distance_m).toBeNull();
  });

  it("clamps the snap to the segment endpoint when the address is past it", () => {
    // Short east-west segment from lng -122.0 to -121.9999 at lat 37.0.
    // Address sits east of the segment endpoint (-121.9990, 37.0).
    const addresses = [mkAddress("a1", 37.0, -121.999)];
    const road: RoadSegmentForMatching = {
      name: "Short Ln",
      road_class: "residential",
      geojson_geometry: JSON.stringify({
        type: "LineString",
        coordinates: [
          [-122.0, 37.0],
          [-121.9999, 37.0],
        ],
      }),
      min_lat: 37.0,
      max_lat: 37.0,
      min_lng: -122.0,
      max_lng: -121.9999,
    };

    attachRoadAccessToAddresses(addresses, [road], { maxDistanceM: 1000 });
    // Snap should land at the eastern endpoint.
    expect(addresses[0]!.row.road_access_lat).toBeCloseTo(37.0, 5);
    expect(addresses[0]!.row.road_access_lng).toBeCloseTo(-121.9999, 5);
  });

  it("falls back to bbox-clamped snapping when geojson_geometry is absent", () => {
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    // No geojson — only bbox. Bbox is a tiny box at (37.0001, -122.0).
    const road: RoadSegmentForMatching = {
      name: "Bboxonly Rd",
      road_class: "residential",
      min_lat: 37.0001,
      max_lat: 37.0001,
      min_lng: -122.0,
      max_lng: -122.0,
    };

    attachRoadAccessToAddresses(addresses, [road]);
    expect(addresses[0]!.row.road_access_road_name).toBe("Bboxonly Rd");
    expect(addresses[0]!.row.road_access_lat).toBeCloseTo(37.0001, 5);
  });

  it("is a no-op when there are no road segments", () => {
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    attachRoadAccessToAddresses(addresses, []);
    expect(addresses[0]!.row.road_access_road_name).toBeNull();
  });

  it("mirrors snapped fields onto the GeoJSON feature properties", () => {
    const addresses = [mkAddress("a1", 37.0, -122.0)];
    const road = eastWestSegment("Main St", 37.0001, -122.0, 200);
    attachRoadAccessToAddresses(addresses, [road]);
    const props = addresses[0]!.feature.properties;
    expect(props.road_access_road_name).toBe("Main St");
    expect(props.road_access_lat).toBeCloseTo(37.0001, 5);
    expect(typeof props.road_access_distance_m).toBe("number");
  });
});
