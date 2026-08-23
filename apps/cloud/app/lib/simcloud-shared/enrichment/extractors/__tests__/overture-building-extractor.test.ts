import { describe, expect, it } from "vitest";
import {
  extractBuildings,
  type OvertureBuildingInput,
} from "../overture-building-extractor";

function squareBuilding(
  id: string,
  lng: number,
  lat: number,
  size = 0.0005, // ~50 m
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

describe("extractBuildings", () => {
  it("returns Aurora-row + GeoJSON feature shapes for every kept building", () => {
    const buildings = [squareBuilding("a", -122.0, 37.0), squareBuilding("b", -122.001, 37.001)];
    const result = extractBuildings(buildings, "map_1", undefined);
    expect(result).toHaveLength(2);
    for (const b of result) {
      expect(b.row.id).toMatch(/^bldg_/);
      expect(b.row.map_asset_id).toBe("map_1");
      expect(b.row.address_count).toBe(0);
      expect(b.feature.type).toBe("Feature");
      expect(b.feature.geometry.type).toBe("Polygon");
      expect(b.rings).not.toBeNull();
    }
  });

  it("drops buildings whose centroid is far from any road point", () => {
    const near = squareBuilding("near", -122.0, 37.0);
    const far = squareBuilding("far", -100.0, 30.0); // ~thousands of km away
    const roads = [{ lat: 37.0, lng: -122.0 }];
    const result = extractBuildings([near, far], "map_1", roads, 50);
    expect(result.map((b) => b.feature.properties.overture_id)).toEqual(["near"]);
  });

  it("keeps all buildings when no road points are available (fallback)", () => {
    const result = extractBuildings(
      [squareBuilding("a", -122, 37), squareBuilding("b", -100, 30)],
      "map_1",
      [],
    );
    expect(result).toHaveLength(2);
  });

  it("falls back to a Point geometry when geom_json is unparseable", () => {
    const broken: OvertureBuildingInput = {
      ...squareBuilding("c", -122, 37),
      geom_json: "{not json",
    };
    const result = extractBuildings([broken], "map_1", undefined);
    expect(result).toHaveLength(1);
    expect(result[0]!.feature.geometry.type).toBe("Point");
    expect(result[0]!.rings).toBeNull();
  });

  it("keeps a large building whose centroid is far from a road but whose bbox corner is close", () => {
    // 200 m × 200 m building (size = 0.001° ≈ 110 m half-width). Centroid
    // sits at (37.0, -122.0). Road point 80 m north — well outside the
    // 50 m radius from the centroid (distance ~80 m), but the bbox's
    // northern corner is only ~30 m from the road. Centroid-only filtering
    // would drop this building; multi-anchor keeps it.
    const big: OvertureBuildingInput = {
      ...squareBuilding("mall", -122.0, 37.0, 0.001),
      name: "Mall",
    };
    // Road point ~80 m north of centroid (0.00072° latitude ≈ 80 m).
    const roads = [{ lat: 37.00072, lng: -122.0 }];
    const result = extractBuildings([big], "map_1", roads, 50);
    expect(result).toHaveLength(1);
    expect(result[0]!.row.name).toBe("Mall");
  });

  it("still drops buildings whose ENTIRE bbox is far from any road", () => {
    // Same large building but road is now ~500 m north — outside even the
    // bbox-corner threshold.
    const big: OvertureBuildingInput = {
      ...squareBuilding("isolated", -122.0, 37.0, 0.001),
      name: "Isolated Warehouse",
    };
    const roads = [{ lat: 37.005, lng: -122.0 }]; // ~556 m north
    const result = extractBuildings([big], "map_1", roads, 50);
    expect(result).toHaveLength(0);
  });

  it("replaces overly-detailed geometry with the bbox polygon (vertex cap)", () => {
    // Hand-craft a polygon with 300 vertices on its outer ring — past the
    // 200-vertex cap. The extractor should swap the geometry for a 5-point
    // bbox polygon while keeping rings (in-memory) intact for the spatial
    // join. Vertices are placed on a small circle to ensure the AABB is
    // tight enough to be a useful approximation in the overlay.
    const cx = -122.0;
    const cy = 37.0;
    const radius = 0.0005;
    const ring: number[][] = [];
    for (let i = 0; i < 300; i++) {
      const t = (i / 300) * Math.PI * 2;
      ring.push([cx + radius * Math.cos(t), cy + radius * Math.sin(t)]);
    }
    ring.push(ring[0]!); // close the ring

    const detailed: OvertureBuildingInput = {
      id: "stadium",
      name: "Big Stadium",
      layer_class: "civic",
      subtype: null,
      height: null,
      num_floors: null,
      centroid_lng: cx,
      centroid_lat: cy,
      min_lng: cx - radius,
      min_lat: cy - radius,
      max_lng: cx + radius,
      max_lat: cy + radius,
      geom_json: JSON.stringify({ type: "Polygon", coordinates: [ring] }),
    };

    const result = extractBuildings([detailed], "map_1", undefined);
    expect(result).toHaveLength(1);
    const b = result[0]!;
    // Overlay geometry: bbox rectangle (5 points: 4 corners + close).
    expect(b.feature.geometry.type).toBe("Polygon");
    const coords = (b.feature.geometry.coordinates as number[][][])[0]!;
    expect(coords).toHaveLength(5);
    // Rings (used for spatial join) stay precise — 301 points preserved.
    expect(b.rings).not.toBeNull();
    expect(b.rings![0]![0]!.length).toBe(301);
  });

  it("keeps the precise geometry for typical buildings (well under the cap)", () => {
    const result = extractBuildings([squareBuilding("a", -122.0, 37.0)], "map_1", undefined);
    const coords = (result[0]!.feature.geometry.coordinates as number[][][])[0]!;
    // Square buildings are 5-point polygons; they must survive untouched.
    expect(coords).toHaveLength(5);
  });

  it("produces stable, deterministic ids across runs", () => {
    const a = extractBuildings([squareBuilding("x", -122, 37)], "map_1", undefined)[0]!;
    const b = extractBuildings([squareBuilding("x", -122, 37)], "map_1", undefined)[0]!;
    expect(a.row.id).toBe(b.row.id);
  });
});
