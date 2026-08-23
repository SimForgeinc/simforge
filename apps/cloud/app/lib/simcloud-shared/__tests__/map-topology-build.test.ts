import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { classifyJunctionTurn } from "../junction-direction";
import {
  buildMapTopologyIndex,
  constrainTopologyToRuntimeLaneTypes,
  parseXodr,
  classifyTurn,
  TOPOLOGY_CONTENT_EPOCH,
} from "../map-topology/build-topology-index";
import {
  CARLA_RUNTIME_ALLOWED_LANE_TYPES,
  MapTopologyIndexSchema,
  type MapTopologyIndex,
  type TopologyGate,
  type TopologyLane,
} from "../map-topology/types";

const MAPS_DIR = "/home/ubuntu/data/maps";
const HAVE_MAPS = existsSync(MAPS_DIR);

/** Every map on disk that has an XODR — [name, xodrPath]. */
function discoverMaps(): Array<[string, string]> {
  if (!HAVE_MAPS) return [];
  const out: Array<[string, string]> = [];
  for (const dir of readdirSync(MAPS_DIR)) {
    const x = `${MAPS_DIR}/${dir}/${dir}.xodr`;
    if (existsSync(x)) out.push([dir, x]);
  }
  return out;
}
const MAPS = discoverMaps();

// ── classifyTurn — pure unit (no files) ─────────────────────────────────────

describe("classifyTurn", () => {
  it("buckets net heading change into turn relations", () => {
    expect(classifyTurn(0)).toBe("Straight");
    expect(classifyTurn(0.2)).toBe("Straight"); // ≤20°
    expect(classifyTurn(-0.2)).toBe("Straight");
    expect(classifyTurn(Math.PI / 2)).toBe("Left"); // +90° CCW
    expect(classifyTurn(-Math.PI / 2)).toBe("Right"); // -90° CW
    expect(classifyTurn(0.6)).toBe("Left");
    expect(classifyTurn(-0.6)).toBe("Right");
    expect(classifyTurn(Math.PI)).toBe("UTurnLeft"); // ≥135°
    expect(classifyTurn(-Math.PI + 0.01)).toBe("UTurnRight");
    // Wraps: 350° ≡ -10° → Straight.
    expect(classifyTurn((350 * Math.PI) / 180)).toBe("Straight");
  });

  /**
   * The class boundaries, to the degree.
   *
   * These used to be radian literals (0.349 and 2.356) that missed 20° and 135°
   * by 0.004° and 0.015°, while `junction-direction.ts` spelled the same two
   * boundaries exactly. That is a gap a real connector fits inside: measured
   * junction branches land within 0.4° of the topology gate's own reading, so a
   * branch sitting on the boundary could be a Left to one classifier and a
   * straight-through to the other, and the two disagreeing about a turn is how a
   * car takes a route the author did not draw.
   *
   * Written in DEGREES converted at the call, not in radians, so the test fails
   * if the boundary moves rather than tracking it.
   */
  it("puts both boundaries exactly where junction-direction puts them", () => {
    const atDeg = (deg: number) => classifyTurn((deg * Math.PI) / 180);
    // Straight is CLOSED at 20°: the band includes its own edge.
    expect(atDeg(20)).toBe("Straight");
    expect(atDeg(-20)).toBe("Straight");
    expect(atDeg(20.001)).toBe("Left");
    expect(atDeg(-20.001)).toBe("Right");
    // As is the U-turn at 135°.
    expect(atDeg(135)).toBe("UTurnLeft");
    expect(atDeg(-135)).toBe("UTurnRight");
    expect(atDeg(134.999)).toBe("Left");
    expect(atDeg(-134.999)).toBe("Right");
    // The old literals sat inside the turn bands; nothing may live there now.
    expect(atDeg((0.349 * 180) / Math.PI)).toBe("Straight");
    expect(atDeg((2.356 * 180) / Math.PI)).toBe("Left");
  });

  it("agrees with classifyJunctionTurn on every class", () => {
    // The point of the wrapper: one classifier, two vocabularies. A sweep rather
    // than samples, because the failure being guarded is a boundary drifting by a
    // fraction of a degree in one copy and not the other.
    for (let deg = -180; deg <= 180; deg += 0.25) {
      const expected = classifyJunctionTurn(deg);
      const actual = classifyTurn((deg * Math.PI) / 180);
      const folded =
        actual === "UTurnLeft" || actual === "UTurnRight"
          ? "uturn"
          : (actual.toLowerCase() as ReturnType<typeof classifyJunctionTurn>);
      expect(folded, `${deg}°`).toBe(expected);
    }
  });
});

// ── Synthetic XODR — hermetic contactPoint reversal (no files needed) ────────

/**
 * One junction, ONE connecting road (10) reached two ways:
 *   - lane -1 via a `contactPoint="start"` connection (incoming road 1),
 *   - lane +1 via a `contactPoint="end"` connection (incoming road 2).
 *
 * Road 10's reference line arcs LEFT (+curvature) in its `+s` direction.
 * The -1 lane travels WITH +s → driver turns Left. The +1 lane travels
 * AGAINST +s (US right-hand-drive sign convention) → the identical
 * geometry is a Right turn for that driver. Turn classification must
 * therefore follow the lane's traversal direction, not the road's
 * authored `+s` heading — and the `contactPoint="end"` connection must
 * parse and gate correctly. This is the Yale conn0 invariant, hermetic.
 */
function contactPointReversalXodr(): string {
  const straight = (id: number, x: number, y: number, succ: string) => `
  <road name="r${id}" length="20.0" id="${id}" junction="-1">
    <link>
      ${succ}
    </link>
    <planView>
      <geometry s="0.0" x="${x}" y="${y}" hdg="0.0" length="20.0">
        <line/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <center><lane id="0" type="none"/></center>
        <right>
          <lane id="-1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>`;
  // Connecting road 10: a +0.15708 rad/m arc over 10m ≈ +90° left in +s.
  const connecting = `
  <road name="r10" length="10.0" id="10" junction="100">
    <planView>
      <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="10.0">
        <arc curvature="0.15708"/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <left>
          <lane id="1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </left>
        <center><lane id="0" type="none"/></center>
        <right>
          <lane id="-1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>`;
  return `<?xml version="1.0"?>
<OpenDRIVE>
${straight(1, -20, 0, '<successor elementType="junction" elementId="100"/>')}
${straight(2, 20, 20, '<successor elementType="junction" elementId="100"/>')}
${connecting}
  <junction id="100" name="j100">
    <connection id="0" incomingRoad="1" connectingRoad="10" contactPoint="start">
      <laneLink from="-1" to="-1"/>
    </connection>
    <connection id="1" incomingRoad="2" connectingRoad="10" contactPoint="end">
      <laneLink from="-1" to="1"/>
    </connection>
  </junction>
</OpenDRIVE>`;
}

describe("contactPoint reversal — traversal-direction turn classification", () => {
  it("parses a contactPoint=\"end\" connection", () => {
    const p = parseXodr(contactPointReversalXodr());
    const j = p.junctions.find((x) => x.id === 100)!;
    expect(j).toBeTruthy();
    expect(j.connections).toHaveLength(2);
    expect(j.connections[0]!.contactPoint).toBe("start");
    expect(j.connections[1]!.contactPoint).toBe("end");
    expect(j.connections[1]!.laneLinks).toEqual([{ from: -1, to: 1 }]);
    expect(p.roads.get(10)!.junction).toBe(100);
  });

  it("classifies the SAME connecting geometry as Left (lane -1, +s) and Right (lane +1, -s)", () => {
    const idx = buildMapTopologyIndex({
      mapName: "synthetic-cp",
      xodr: contactPointReversalXodr(),
    });
    const gate = (id: string) => idx.gates.find((g) => g.id === id);

    // conn0: lane -1 travels WITH +s on a left-arcing road → Left.
    const gStart = gate("100:0:-1--1")!;
    expect(gStart, "start-contact gate").toBeTruthy();
    expect(gStart.connectingLaneRsl).toBe("10:0:-1");
    expect(gStart.turnRelation).toBe("Left");
    expect(gStart.headingChangeRad).toBeGreaterThan(0.349);

    // conn1: lane +1 travels AGAINST +s on the SAME road → Right, and it
    // arrived through a contactPoint="end" connection.
    const gEnd = gate("100:1:-1-1")!;
    expect(gEnd, "end-contact gate").toBeTruthy();
    expect(gEnd.connectingLaneRsl).toBe("10:0:1");
    expect(gEnd.turnRelation).toBe("Right");
    expect(gEnd.headingChangeRad).toBeLessThan(-0.349);

    // Mirrored across the lane-sign / contact-point reversal: equal
    // magnitude, opposite sign.
    expect(gEnd.headingChangeRad).toBeCloseTo(-gStart.headingChangeRad, 5);
  });
});

// ── Junction connecting-road directionality (Yale road 133 regression) ─────

function yaleRoad133DirectionXodr(): string {
  const road = ({
    id,
    laneId,
    link,
    laneLink,
    junction = -1,
    x = 0,
  }: {
    id: number;
    laneId: number;
    link: string;
    laneLink: string;
    junction?: number;
    x?: number;
  }) => `
  <road name="r${id}" length="24.0" id="${id}" junction="${junction}">
    <link>
      ${link}
    </link>
    <planView>
      <geometry s="0.0" x="${x}" y="0.0" hdg="0.0" length="24.0">
        <line/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <left>
          <lane id="${laneId}" type="driving">
            <link>
              ${laneLink}
            </link>
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </left>
        <center><lane id="0" type="none"/></center>
      </laneSection>
    </lanes>
  </road>`;

  return `<?xml version="1.0"?>
<OpenDRIVE>
${road({
    id: 27,
    laneId: 3,
    link: '<predecessor elementType="junction" elementId="115"/>',
    laneLink: '<predecessor id="3"/>',
    x: 24,
  })}
${road({
    id: 109,
    laneId: 4,
    link: '<successor elementType="junction" elementId="115"/>',
    laneLink: '<successor id="4"/>',
    x: -24,
  })}
${road({
    id: 133,
    laneId: 1,
    junction: 115,
    link: `<predecessor elementType="road" elementId="109" contactPoint="end"/>
      <successor elementType="road" elementId="27" contactPoint="start"/>`,
    laneLink: `<predecessor id="4"/>
              <successor id="3"/>`,
  })}
  <junction id="115" name="j115">
    <connection id="0" incomingRoad="27" connectingRoad="133" contactPoint="end">
      <laneLink from="3" to="1"/>
    </connection>
  </junction>
</OpenDRIVE>`;
}

describe("junction connecting-road directionality", () => {
  it("uses laneLink direction exclusively for Yale-style positive-id connecting lanes", () => {
    const idx = buildMapTopologyIndex({
      mapName: "yale-road-133-regression",
      xodr: yaleRoad133DirectionXodr(),
    });

    expect(idx.lanes["133:0:1"]!.predecessors).toEqual(["27:0:3"]);
    expect(idx.lanes["133:0:1"]!.successors).toEqual(["109:0:4"]);
    expect(idx.lanes["27:0:3"]!.successors).toEqual(["133:0:1"]);
    expect(idx.lanes["27:0:3"]!.predecessors).not.toContain("133:0:1");
    expect(idx.lanes["109:0:4"]!.predecessors).toEqual(["133:0:1"]);
    expect(idx.lanes["109:0:4"]!.successors).not.toContain("133:0:1");
  });
});

// ── Attribute-order independence (hermetic) ──────────────────────────────────

/** One-tag-per-line XODR exercising road/lane/geometry/arc/width/speed/
 *  link/junction/connection/laneLink — enough to shuffle every relevant
 *  tag's attribute order. */
function attrOrderXodr(): string {
  return `<?xml version="1.0"?>
<OpenDRIVE>
  <road name="r1" length="40.0" id="1" junction="-1">
    <link>
      <successor elementType="junction" elementId="100"/>
    </link>
    <planView>
      <geometry s="0.0" x="-40.0" y="0.0" hdg="0.0" length="40.0">
        <line/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <center>
          <lane id="0" type="none"/>
        </center>
        <right>
          <lane id="-1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
            <speed sOffset="0.0" max="30.0" unit="mph"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
  <road name="r10" length="12.0" id="10" junction="100">
    <planView>
      <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="12.0">
        <arc curvature="0.13"/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <center>
          <lane id="0" type="none"/>
        </center>
        <right>
          <lane id="-1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>
  <junction id="100" name="j100">
    <connection id="0" incomingRoad="1" connectingRoad="10" contactPoint="start">
      <laneLink from="-1" to="-1"/>
    </connection>
  </junction>
</OpenDRIVE>`;
}

/** Reverse the attribute order on every single-tag line, leaving the tag
 *  name and `>`/`/>` terminator intact. */
function shuffleTagAttrs(xodr: string): string {
  const TAG = /^(\s*)(<\/?[A-Za-z][\w]*)((?:\s+[A-Za-z_][\w.-]*="[^"]*")+)(\s*\/?>)\s*$/;
  return xodr
    .split("\n")
    .map((line) => {
      const m = TAG.exec(line);
      if (!m) return line;
      const attrs = m[3]!.match(/[A-Za-z_][\w.-]*="[^"]*"/g) ?? [];
      if (attrs.length < 2) return line;
      return `${m[1]}${m[2]} ${[...attrs].reverse().join(" ")}${m[4]}`;
    })
    .join("\n");
}

describe("XODR numeric-attribute validation", () => {
  it("treats a non-numeric id as missing (no NaN map keys) rather than corrupting connectivity", () => {
    const road = (id: string) => `
  <road name="r${id}" length="10.0" id="${id}" junction="-1">
    <planView>
      <geometry s="0.0" x="0.0" y="0.0" hdg="0.0" length="10.0">
        <line/>
      </geometry>
    </planView>
    <lanes>
      <laneSection s="0.0">
        <center><lane id="0" type="none"/></center>
        <right>
          <lane id="-1" type="driving">
            <width sOffset="0.0" a="3.5" b="0.0" c="0.0" d="0.0"/>
          </lane>
        </right>
      </laneSection>
    </lanes>
  </road>`;
    // Two roads with non-numeric ids must NOT both collapse onto a single
    // NaN key and overwrite each other; they should be dropped cleanly,
    // leaving the well-formed road intact.
    const p = parseXodr(
      `<?xml version="1.0"?>\n<OpenDRIVE>${road("abc")}${road("xyz")}${road("5")}\n</OpenDRIVE>`,
    );
    expect([...p.roads.keys()].some((k) => Number.isNaN(k))).toBe(false);
    expect(p.roads.has(NaN)).toBe(false);
    expect(p.roads.has(5)).toBe(true);
  });
});

describe("XODR parsing is attribute-order independent", () => {
  it("builds an identical topology when every tag's attributes are reordered", () => {
    const now = () => "2026-05-22T00:00:00.000Z";
    const canonical = buildMapTopologyIndex({
      mapName: "attr-order",
      xodr: attrOrderXodr(),
      now,
    });
    // Guard against a vacuous comparison: the canonical build must be a
    // real left-turn gate with sampled geometry.
    expect(canonical.gates).toHaveLength(1);
    expect(canonical.gates[0]!.turnRelation).toBe("Left");
    expect(canonical.lanes["10:0:-1"]!.polyline.length).toBeGreaterThan(4);

    const shuffled = buildMapTopologyIndex({
      mapName: "attr-order",
      xodr: shuffleTagAttrs(attrOrderXodr()),
      now,
    });
    expect(shuffled).toEqual(canonical);
  });
});

describe("a compiled topology index is a pure function of its XODR", () => {
  /**
   * The property `/api/internal/autogen/maps/{id}/topology` depends on.
   *
   * That route hashes the whole index with `JSON.stringify` to produce
   * `payloadSha256`, which is how a batch records which map bytes it drew
   * against. `JSON.stringify` is sensitive to BOTH scalar values and key
   * insertion order, so this asserts the strictly stronger property: repeated
   * compiles are byte-identical, not merely deep-equal.
   *
   * It regressed once already, as a wall-clock `generatedAt` default — every
   * call served a different digest for an unchanged map. A deep-equality check
   * would not have caught a key-order regression, and `toEqual` would not have
   * caught the timestamp either way, so compare the serialized bytes.
   */
  const digest = (index: unknown) =>
    createHash("sha256").update(JSON.stringify(index), "utf8").digest("hex");

  it("compiles to identical bytes on every call", () => {
    const compiles = Array.from({ length: 5 }, () =>
      buildMapTopologyIndex({ mapName: "purity", xodr: attrOrderXodr() }),
    );

    // Guard against a vacuous comparison: the index must have real content.
    expect(compiles[0]!.gates).toHaveLength(1);
    expect(Object.keys(compiles[0]!.lanes).length).toBeGreaterThan(0);

    const serialized = compiles.map((index) => JSON.stringify(index));
    expect(new Set(serialized).size).toBe(1);
    expect(new Set(compiles.map(digest)).size).toBe(1);
  });

  it("defaults generatedAt to the content epoch rather than wall-clock time", () => {
    const index = buildMapTopologyIndex({ mapName: "purity", xodr: attrOrderXodr() });
    expect(index.generatedAt).toBe(TOPOLOGY_CONTENT_EPOCH);
  });

  it("still lets a caller stamp a real time when the output is not digest-bound", () => {
    const index = buildMapTopologyIndex({
      mapName: "purity",
      xodr: attrOrderXodr(),
      now: () => "2026-08-19T12:00:00.000Z",
    });
    expect(index.generatedAt).toBe("2026-08-19T12:00:00.000Z");
  });

  it("keeps lane and gate ordering stable across compiles", () => {
    const a = buildMapTopologyIndex({ mapName: "purity", xodr: attrOrderXodr() });
    const b = buildMapTopologyIndex({ mapName: "purity", xodr: attrOrderXodr() });
    expect(Object.keys(b.lanes)).toEqual(Object.keys(a.lanes));
    expect(b.gates.map((g) => g.id)).toEqual(a.gates.map((g) => g.id));
    expect(Object.keys(b.junctions)).toEqual(Object.keys(a.junctions));
  });
});

// ── Yale_St_Fixed — hand-derived anchors from the real XODR ──────────────────

const YALE = `${MAPS_DIR}/Yale_St_Fixed/Yale_St_Fixed.xodr`;
describe.skipIf(!existsSync(YALE))("Yale_St_Fixed — hand-verified", () => {
  const xodr = existsSync(YALE) ? readFileSync(YALE, "utf8") : "";

  it("parseXodr reads junction 115's connection 0 (27→116) and road 116 geometry", () => {
    const p = parseXodr(xodr);
    const j115 = p.junctions.find((j) => j.id === 115)!;
    expect(j115).toBeTruthy();
    const c0 = j115.connections[0]!;
    expect(c0.incomingRoad).toBe(27);
    expect(c0.connectingRoad).toBe(116);
    expect(c0.contactPoint).toBe("end");
    expect(c0.laneLinks).toEqual([{ from: 4, to: 1 }]);

    const r116 = p.roads.get(116)!;
    expect(r116.junction).toBe(115);
    // 4 planView geometries: line, arc, arc, line (verified in source).
    expect(r116.geom.length).toBe(4);
    expect(r116.geom[0]!.hdg).toBeCloseTo(0.98447834, 5);
    expect(r116.geom[0]!.kind.kind).toBe("line");
    expect(r116.geom[2]!.kind.kind).toBe("arc");
    if (r116.geom[2]!.kind.kind === "arc") {
      expect(r116.geom[2]!.kind.curvature).toBeCloseTo(0.26489626, 6);
    }
    expect(r116.geom[3]!.hdg).toBeCloseTo(2.5574607, 5);
  });

  it("derives Left/Right/Straight in LANE TRAVEL direction (sign-aware)", () => {
    const idx = buildMapTopologyIndex({ mapName: "yale-street", xodr });
    const gate = (id: string) => idx.gates.find((g) => g.id === id);

    // conn0 → road 116, lane id +1: the road's +s direction has a
    // +1.573 rad rotation, but positive-id lanes travel OPPOSITE +s
    // (US right-hand-drive convention) — so the driver actually
    // experiences a -1.573 rad rotation → **Right** turn.
    const g116 = gate("115:0:4-1")!;
    expect(g116).toBeTruthy();
    expect(g116.connectingLaneRsl).toBe("116:0:1");
    expect(g116.headingChangeRad).toBeCloseTo(-1.573, 2);
    expect(g116.turnRelation).toBe("Right");

    // conn1 → road 120, lane id -1: negative-id lanes travel WITH +s,
    // so the road's heading change is the lane's heading change
    // unchanged. Road net ≈ -1.553 rad → **Right**.
    const g120 = gate("115:1:-1--1")!;
    expect(g120).toBeTruthy();
    expect(g120.connectingLaneRsl).toBe("120:0:-1");
    expect(g120.turnRelation).toBe("Right");
    expect(g120.headingChangeRad).toBeLessThan(-1);

    // conn3 → road 128, lane id +1: road net ≈ -0.016 rad, sign-flipped
    // to +0.016 in travel direction — still **Straight** (|Δ| ≤ 20°).
    const g128 = gate("115:3:2-1")!;
    expect(g128).toBeTruthy();
    expect(g128.connectingLaneRsl).toBe("128:0:1");
    expect(g128.turnRelation).toBe("Straight");
    expect(Math.abs(g128.headingChangeRad)).toBeLessThan(0.1);
  });

  it("connecting lane is junction-internal and back-links its approach", () => {
    const idx = buildMapTopologyIndex({ mapName: "yale-street", xodr });
    const g = idx.gates.find((x) => x.id === "115:0:4-1")!;
    const conn = idx.lanes[g.connectingLaneRsl]!;
    expect(conn.isJunction).toBe(true);
    expect(conn.junctionId).toBe("115");
    expect(g.approachLaneRsl).toMatch(/^27:\d+:4$/);
    expect(idx.lanes[g.approachLaneRsl]).toBeTruthy();
    // addEdge(approach → connecting) ⇒ symmetric back-link.
    expect(conn.predecessors).toContain(g.approachLaneRsl);
    const j = idx.junctions["115"]!;
    expect(j.gateIds).toContain("115:0:4-1");
    expect(j.internalLaneRsls).toContain("116:0:1");
  });
});

// ── Cross-map invariants — every map on disk ────────────────────────────────

describe.skipIf(MAPS.length === 0)("topology invariants — all maps on disk", () => {
  const built = new Map<string, MapTopologyIndex>();
  const idxFor = (name: string, xodrPath: string) => {
    let v = built.get(name);
    if (!v) {
      v = buildMapTopologyIndex({
        mapName: name,
        xodr: readFileSync(xodrPath, "utf8"),
      });
      built.set(name, v);
    }
    return v;
  };

  it.each(MAPS)("%s — schema valid, sane stats, real turn mix", (name, x) => {
    const idx = idxFor(name, x);
    expect(() => MapTopologyIndexSchema.parse(idx)).not.toThrow();
    expect(idx.stats.junctions).toBeGreaterThan(0);
    expect(idx.stats.gates).toBeGreaterThan(0);
    expect(idx.stats.drivingLanes).toBeGreaterThan(10);
    // Real maps have all three primary turn types.
    for (const t of ["Left", "Right", "Straight"]) {
      expect(idx.stats.turnHistogram[t] ?? 0).toBeGreaterThan(0);
    }
    expect(
      idx.stats.gatesDropped / Math.max(1, idx.stats.connectionsParsed),
    ).toBeLessThan(0.1);
  });

  it.each(MAPS)("%s — gate lanes resolve; connecting lanes are junction-internal", (name, x) => {
    const idx = idxFor(name, x);
    for (const g of idx.gates) {
      const conn = idx.lanes[g.connectingLaneRsl];
      const appr = idx.lanes[g.approachLaneRsl];
      expect(conn, `${g.id} connecting`).toBeTruthy();
      expect(appr, `${g.id} approach`).toBeTruthy();
      expect(conn!.isJunction).toBe(true);
      expect(idx.junctions[conn!.junctionId!]).toBeTruthy();
    }
  });

  it.each(MAPS)("%s — predecessor index round-trips with successors (≥99%)", (name, x) => {
    const idx = idxFor(name, x);
    let checked = 0;
    let symmetric = 0;
    for (const lane of Object.values(idx.lanes)) {
      for (const sRsl of lane.successors) {
        if (!idx.lanes[sRsl]) continue;
        checked += 1;
        if (idx.lanes[sRsl]!.predecessors.includes(lane.rsl)) symmetric += 1;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(symmetric / checked).toBeGreaterThan(0.99);
  });

  it.each(MAPS)("%s — Left gates turn CCW, Right gates CW (sign sanity)", (name, x) => {
    const idx = idxFor(name, x);
    const lefts = idx.gates.filter((g) => g.turnRelation === "Left");
    const rights = idx.gates.filter((g) => g.turnRelation === "Right");
    expect(lefts.length + rights.length).toBeGreaterThan(0);
    // Allow a small tolerance band around the classifier thresholds.
    expect(lefts.every((g) => g.headingChangeRad > 0.2)).toBe(true);
    expect(rights.every((g) => g.headingChangeRad < -0.2)).toBe(true);
  });

  // ── Polylines (schema v2) ─────────────────────────────────────────────────
  it.each(MAPS)("%s — every driving lane has a ≥2-point polyline", (name, x) => {
    const idx = idxFor(name, x);
    const driving = Object.values(idx.lanes).filter((l) => l.laneType === "driving");
    expect(driving.length).toBeGreaterThan(10);
    const missing = driving.filter((l) => l.polyline.length < 2);
    // Allow ≤1% to slip (zero-length sections, malformed widths). The
    // gated planner tolerates lane misses by falling back to legacy; the
    // critical mass of lanes must be covered.
    expect(missing.length / driving.length).toBeLessThan(0.01);
  });

  it.each(MAPS)("%s — gate lane polylines connect end-to-end (within 2m)", (name, x) => {
    const idx = idxFor(name, x);
    // Sample 30 gates; for each, check the approach lane's near-endpoint
    // is near the connecting lane's near-endpoint (either start or end).
    // Allows for lane-sign orientation differences — we only require the
    // polylines to MEET somewhere within tolerance.
    let checked = 0;
    let meeting = 0;
    for (const g of idx.gates.slice(0, 30)) {
      const a = idx.lanes[g.approachLaneRsl]?.polyline ?? [];
      const c = idx.lanes[g.connectingLaneRsl]?.polyline ?? [];
      if (a.length < 2 || c.length < 2) continue;
      checked += 1;
      const ends = [a[0]!, a[a.length - 1]!];
      const cEnds = [c[0]!, c[c.length - 1]!];
      let minD = Infinity;
      for (const ae of ends) {
        for (const ce of cEnds) {
          const d = Math.hypot(ae.x - ce.x, ae.y - ce.y);
          if (d < minD) minD = d;
        }
      }
      if (minD < 2.0) meeting += 1;
    }
    expect(checked).toBeGreaterThan(0);
    // ≥85% must meet — junction connectivity is a hard XODR invariant.
    expect(meeting / checked).toBeGreaterThan(0.85);
  });

  it.each(MAPS)("%s — lane polylines are roughly straight per arc (no NaN, no exploding length)", (name, x) => {
    const idx = idxFor(name, x);
    const driving = Object.values(idx.lanes).filter(
      (l) => l.laneType === "driving" && l.polyline.length >= 2,
    );
    for (const l of driving.slice(0, 200)) {
      let arc = 0;
      for (let i = 1; i < l.polyline.length; i++) {
        const a = l.polyline[i - 1]!;
        const b = l.polyline[i]!;
        expect(Number.isFinite(a.x) && Number.isFinite(a.y)).toBe(true);
        expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
        arc += Math.hypot(b.x - a.x, b.y - a.y);
      }
      // Lanes longer than 5km would indicate a runaway integration.
      expect(arc).toBeLessThan(5000);
    }
  });
});

// ── constrainTopologyToRuntimeLaneTypes — pure unit (no files) ──────────────

describe("constrainTopologyToRuntimeLaneTypes", () => {
  const mkLane = (
    rsl: string,
    laneType: string,
    extra: Partial<TopologyLane> = {},
  ): TopologyLane => ({
    rsl,
    roadId: Number(rsl.split(":")[0]),
    section: 0,
    laneId: Number(rsl.split(":")[2]),
    laneType,
    isJunction: false,
    junctionId: null,
    predecessors: [],
    successors: [],
    speedLimitKph: null,
    polyline: [],
    ...extra,
  });

  it("drops disallowed lane types and prunes dangling edges", () => {
    const lanes: Record<string, TopologyLane> = {
      "1:0:-1": mkLane("1:0:-1", "driving", {
        successors: ["1:0:-2", "1:0:-3"],
      }),
      "1:0:-2": mkLane("1:0:-2", "sidewalk"),
      "1:0:-3": mkLane("1:0:-3", "median", { predecessors: ["1:0:-1"] }),
      "1:0:-4": mkLane("1:0:-4", "restricted"),
    };
    constrainTopologyToRuntimeLaneTypes(lanes, []);

    expect(Object.keys(lanes).sort()).toEqual(["1:0:-1", "1:0:-2"]);
    // Edge to the dropped median lane is pruned; sidewalk edge survives.
    expect(lanes["1:0:-1"]!.successors).toEqual(["1:0:-2"]);
  });

  it("preserves a gate's connecting lane even when typed 'none'", () => {
    const lanes: Record<string, TopologyLane> = {
      "1:0:-1": mkLane("1:0:-1", "driving", { successors: ["9:0:-1"] }),
      "9:0:-1": mkLane("9:0:-1", "none", {
        isJunction: true,
        junctionId: "5",
        predecessors: ["1:0:-1"],
        successors: ["2:0:-1"],
      }),
      "2:0:-1": mkLane("2:0:-1", "driving", { predecessors: ["9:0:-1"] }),
    };
    const gates: TopologyGate[] = [
      {
        id: "5:0:-1--1",
        junctionId: "5",
        turnRelation: "Left",
        headingChangeRad: 1.2,
        connectingLaneRsl: "9:0:-1",
        approachLaneRsl: "1:0:-1",
        exitLaneRsls: ["2:0:-1"],
      },
    ];
    constrainTopologyToRuntimeLaneTypes(lanes, gates);

    // The 'none'-typed connecting lane is retained because a gate references it.
    expect(lanes["9:0:-1"]).toBeTruthy();
    expect(lanes["1:0:-1"]!.successors).toEqual(["9:0:-1"]);
    expect(lanes["9:0:-1"]!.successors).toEqual(["2:0:-1"]);
  });

  it("leaves no dangling lane references in edges or gates", () => {
    const lanes: Record<string, TopologyLane> = {
      "1:0:-1": mkLane("1:0:-1", "driving", {
        successors: ["1:0:-2", "1:0:-9", "9:0:-1"],
        predecessors: ["3:0:-1"],
      }),
      "1:0:-2": mkLane("1:0:-2", "sidewalk", { predecessors: ["1:0:-1"] }),
      "1:0:-9": mkLane("1:0:-9", "restricted"), // dropped
      "3:0:-1": mkLane("3:0:-1", "median"), // dropped
      "9:0:-1": mkLane("9:0:-1", "none", {
        isJunction: true,
        junctionId: "5",
        predecessors: ["1:0:-1"],
        successors: ["2:0:-1"],
      }),
      "2:0:-1": mkLane("2:0:-1", "driving", { predecessors: ["9:0:-1"] }),
    };
    const gates: TopologyGate[] = [
      {
        id: "5:0:-1--1",
        junctionId: "5",
        turnRelation: "Straight",
        headingChangeRad: 0,
        connectingLaneRsl: "9:0:-1",
        approachLaneRsl: "1:0:-1",
        exitLaneRsls: ["2:0:-1"],
      },
    ];
    constrainTopologyToRuntimeLaneTypes(lanes, gates);

    for (const lane of Object.values(lanes)) {
      for (const p of lane.predecessors) expect(lanes[p], `pred ${p}`).toBeTruthy();
      for (const s of lane.successors) expect(lanes[s], `succ ${s}`).toBeTruthy();
    }
    for (const g of gates) {
      expect(lanes[g.approachLaneRsl], g.approachLaneRsl).toBeTruthy();
      expect(lanes[g.connectingLaneRsl], g.connectingLaneRsl).toBeTruthy();
      for (const e of g.exitLaneRsls) expect(lanes[e], e).toBeTruthy();
    }
  });

  it("via buildMapTopologyIndex: built indexes contain only allowed lane types", () => {
    if (MAPS.length === 0) return; // requires on-disk maps
    for (const [name, x] of MAPS) {
      const idx = idxFor(name, x);
      const gateRsls = new Set<string>();
      for (const g of idx.gates) {
        gateRsls.add(g.approachLaneRsl);
        gateRsls.add(g.connectingLaneRsl);
        for (const e of g.exitLaneRsls) gateRsls.add(e);
      }
      const offenders = Object.values(idx.lanes).filter(
        (l) =>
          !CARLA_RUNTIME_ALLOWED_LANE_TYPES.has(l.laneType.toLowerCase()) &&
          !gateRsls.has(l.rsl),
      );
      expect(offenders).toEqual([]);
    }
  });

  it.each(MAPS)(
    "%s — built index has no dangling references after filtering",
    (name, x) => {
      const idx = idxFor(name, x);
      const laneIds = new Set(Object.keys(idx.lanes));
      const gateIds = new Set(idx.gates.map((g) => g.id));

      for (const lane of Object.values(idx.lanes)) {
        for (const p of lane.predecessors) expect(laneIds.has(p)).toBe(true);
        for (const s of lane.successors) expect(laneIds.has(s)).toBe(true);
      }
      for (const g of idx.gates) {
        expect(laneIds.has(g.approachLaneRsl)).toBe(true);
        expect(laneIds.has(g.connectingLaneRsl)).toBe(true);
        for (const e of g.exitLaneRsls) expect(laneIds.has(e)).toBe(true);
      }
      for (const j of Object.values(idx.junctions)) {
        for (const gid of j.gateIds) expect(gateIds.has(gid)).toBe(true);
        for (const rsl of j.internalLaneRsls) expect(laneIds.has(rsl)).toBe(true);
        for (const rsl of j.approachLaneRsls) expect(laneIds.has(rsl)).toBe(true);
      }
    },
  );
});

// ── lane-type contract with the worker crawl ────────────────────────────────

describe("CARLA_RUNTIME_ALLOWED_LANE_TYPES", () => {
  it("keeps the client-side allow-list pinned (ramps intentionally absent)", () => {
    expect(new Set(CARLA_RUNTIME_ALLOWED_LANE_TYPES)).toEqual(
      new Set(["driving", "bidirectional", "parking", "shoulder", "sidewalk", "biking"]),
    );
  });
});
