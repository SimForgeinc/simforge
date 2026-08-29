import { describe, it, expect } from "vitest";
import { buildLanePolygonsLocal } from "@simforge-oss/maps/topology";

// Minimal straight, 20 m road along +x with one driving lane each side of the
// reference line. Each lane is a constant 3 m wide (`<width a="3" .../>`), so
// the reconstructed polygon must be a ~20 m × 3 m ribbon.
const STRAIGHT_XODR = `<?xml version="1.0"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="6" name="t" />
  <road name="Main" length="20.0" id="1" junction="-1">
    <planView>
      <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="20.0"><line/></geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <left>
          <lane id="1" type="driving" level="false">
            <width sOffset="0.0" a="3.0" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </left>
        <center>
          <lane id="0" type="none" level="false"/>
        </center>
        <right>
          <lane id="-1" type="driving" level="false">
            <width sOffset="0.0" a="3.0" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
</OpenDRIVE>`;

function ringBounds(ring: { x: number; y: number }[]) {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("buildLanePolygonsLocal", () => {
  it("reconstructs a ribbon polygon per non-reference lane from XODR widths", () => {
    const polys = buildLanePolygonsLocal(STRAIGHT_XODR);
    // Two drivable lanes (ids +1, -1); the id-0 reference lane is skipped.
    expect(polys).toHaveLength(2);

    for (const poly of polys) {
      expect(poly.laneType).toBe("driving");
      // Closed ring (first == last) with enough vertices to trace both edges.
      expect(poly.ring.length).toBeGreaterThanOrEqual(4);
      expect(poly.ring[0]).toEqual(poly.ring[poly.ring.length - 1]);

      const b = ringBounds(poly.ring);
      // ~20 m long along x.
      expect(b.maxX - b.minX).toBeGreaterThan(19);
      expect(b.maxX - b.minX).toBeLessThan(21);
      // ~3 m wide across y.
      expect(b.maxY - b.minY).toBeGreaterThan(2.5);
      expect(b.maxY - b.minY).toBeLessThan(3.5);
    }

    // The +1 lane sits left of the reference line (y in [0,3]); the -1 lane to
    // the right (y in [-3,0]).
    const left = polys.find((p) => p.laneId === 1)!;
    const right = polys.find((p) => p.laneId === -1)!;
    expect(ringBounds(left.ring).minY).toBeGreaterThanOrEqual(-0.01);
    expect(ringBounds(right.ring).maxY).toBeLessThanOrEqual(0.01);
  });

  it("skips lanes that have no width polynomial", () => {
    const noWidth = STRAIGHT_XODR.replace(
      /<width[^/]*\/>/g,
      "",
    );
    expect(buildLanePolygonsLocal(noWidth)).toHaveLength(0);
  });

  it("captures the RoadRunner lane GUID from <userData><vectorLane laneId>", () => {
    // RoadRunner-exported XODR tags each lane with its scene GUID — the same id
    // the authored GeoJSON carries as the lane feature's `Id`.
    const xodr = `<?xml version="1.0"?>
<OpenDRIVE>
  <header revMajor="1" revMinor="6" name="t" />
  <road name="Main" length="20.0" id="1" junction="-1">
    <planView>
      <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="20.0"><line/></geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <center><lane id="0" type="none" level="false"/></center>
        <right>
          <lane id="-1" type="driving" level="false">
            <width sOffset="0.0" a="3.0" b="0.0" c="0.0" d="0.0"/>
            <userData>
              <vectorLane sOffset="0.0" laneId="{11111111-1111-1111-1111-111111111111}" travelDir="forward"/>
            </userData>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
</OpenDRIVE>`;
    const polys = buildLanePolygonsLocal(xodr);
    expect(polys).toHaveLength(1);
    expect(polys[0]!.laneGuid).toBe("{11111111-1111-1111-1111-111111111111}");
  });
});
