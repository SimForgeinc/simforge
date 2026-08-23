import { describe, expect, it } from "vitest";
import {
  parsePolygonRings,
  pointInBbox,
  pointInPolygon,
} from "../point-in-polygon";

const SQUARE_RING: [number, number][] = [
  [-122.0, 37.0],
  [-121.0, 37.0],
  [-121.0, 38.0],
  [-122.0, 38.0],
  [-122.0, 37.0], // closed
];

describe("pointInPolygon", () => {
  it("returns true for points clearly inside the outer ring", () => {
    expect(pointInPolygon(-121.5, 37.5, [SQUARE_RING])).toBe(true);
  });

  it("returns false for points outside the outer ring", () => {
    expect(pointInPolygon(-120.5, 37.5, [SQUARE_RING])).toBe(false);
    expect(pointInPolygon(-122.5, 37.5, [SQUARE_RING])).toBe(false);
    expect(pointInPolygon(-121.5, 36.5, [SQUARE_RING])).toBe(false);
  });

  it("excludes points inside a hole", () => {
    const hole: [number, number][] = [
      [-121.7, 37.3],
      [-121.3, 37.3],
      [-121.3, 37.7],
      [-121.7, 37.7],
      [-121.7, 37.3],
    ];
    // Center of the hole.
    expect(pointInPolygon(-121.5, 37.5, [SQUARE_RING, hole])).toBe(false);
    // Inside outer ring but outside hole.
    expect(pointInPolygon(-121.1, 37.1, [SQUARE_RING, hole])).toBe(true);
  });

  it("returns false for an empty ring set", () => {
    expect(pointInPolygon(0, 0, [])).toBe(false);
  });
});

describe("pointInBbox", () => {
  it("inclusive on the boundary", () => {
    expect(pointInBbox(-121.5, 37.5, { min_lat: 37, min_lng: -122, max_lat: 38, max_lng: -121 })).toBe(true);
    expect(pointInBbox(-122, 37, { min_lat: 37, min_lng: -122, max_lat: 38, max_lng: -121 })).toBe(true);
    expect(pointInBbox(-120.99, 37.5, { min_lat: 37, min_lng: -122, max_lat: 38, max_lng: -121 })).toBe(false);
  });
});

describe("parsePolygonRings", () => {
  it("parses a Polygon into a single ring set", () => {
    const json = JSON.stringify({
      type: "Polygon",
      coordinates: [SQUARE_RING],
    });
    const parsed = parsePolygonRings(json);
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBe(1); // one part (Polygon)
    expect(parsed?.[0]?.length).toBe(1); // one ring in that part (no holes)
    expect(parsed?.[0]?.[0]?.length).toBe(SQUARE_RING.length); // vertex count
  });

  it("parses a MultiPolygon into one ring set per part", () => {
    const json = JSON.stringify({
      type: "MultiPolygon",
      coordinates: [[SQUARE_RING], [SQUARE_RING]],
    });
    const parsed = parsePolygonRings(json);
    expect(parsed?.length).toBe(2);
  });

  it("returns null on parse failure or unexpected shape", () => {
    expect(parsePolygonRings(null)).toBeNull();
    expect(parsePolygonRings("")).toBeNull();
    expect(parsePolygonRings("not json")).toBeNull();
    expect(parsePolygonRings(JSON.stringify({ type: "Point", coordinates: [0, 0] }))).toBeNull();
  });
});
