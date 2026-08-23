import { describe, it, expect } from "vitest";
import { buildCrosswalks } from "../crosswalk-builder";
import type { CoordTransform } from "../../xodr-geometry";

const TRANSFORM: CoordTransform = {
  originLat: 37.4,
  originLon: -122.1,
  scale: 1,
};

const ROAD_HEADER = `
<road id="r1" length="100">
  <planView>
    <geometry s="0" x="0" y="0" hdg="0" length="100">
      <line/>
    </geometry>
  </planView>
  <objects>`;

const ROAD_FOOTER = `  </objects>
</road>`;

function xodrWithObjects(objects: string): string {
  return `<?xml version="1.0"?>
<OpenDRIVE>
  <header>
    <geoReference><![CDATA[+proj=tmerc +lat_0=37.4 +lon_0=-122.1 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs]]></geoReference>
  </header>
  ${ROAD_HEADER}
${objects}
  ${ROAD_FOOTER}
</OpenDRIVE>`;
}

describe("buildCrosswalks", () => {
  it("matches OpenDRIVE-spec crosswalks with type=\"crosswalk\"", () => {
    const xodr = xodrWithObjects(
      `<object id="cw1" type="crosswalk" name="LadderCrosswalk" s="10" t="0" hdg="0" width="3" length="8"/>`,
    );
    const { entities } = buildCrosswalks(xodr, TRANSFORM, []);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.xodrObjectId).toBe("cw1");
  });

  it("matches RoadRunner duplicate-export form (type=\"-1\" + Crosswalk-named)", () => {
    // The RoadRunner export bug: duplicated crosswalks lose type="crosswalk"
    // and get type="-1" while keeping a "*Crosswalk*" name. Belmont's XODR
    // has 8 crosswalks all in this shape — the strict regex used to drop
    // them all, leaving zero detector_crosswalk candidates and no search
    // results for "crosswalks" on that map.
    const xodr = xodrWithObjects(`
      <object id="bare" type="-1" name="Crosswalk" s="10" t="0" hdg="0" width="3" length="8"/>
      <object id="prefixed" type="-1" name="SimpleCrosswalk" s="20" t="0" hdg="0" width="3" length="8"/>
      <object id="ladder-dup" type="-1" name="LadderCrosswalk (2)" s="30" t="0" hdg="0" width="3" length="8"/>
      <object id="bare-dup" type="-1" name="Crosswalk (3)" s="40" t="0" hdg="0" width="3" length="8"/>
    `);
    const { entities } = buildCrosswalks(xodr, TRANSFORM, []);
    const ids = entities.map((e) => e.xodrObjectId).sort();
    expect(ids).toEqual(["bare", "bare-dup", "ladder-dup", "prefixed"]);
  });

  it("does not match unrelated objects with type=\"-1\"", () => {
    const xodr = xodrWithObjects(`
      <object id="other" type="-1" name="StreetLamp" s="10" t="0" hdg="0" width="1" length="1"/>
      <object id="sign" type="-1" name="Sign_R1-1" s="20" t="0" hdg="0" width="0.5" length="0.5"/>
    `);
    const { entities } = buildCrosswalks(xodr, TRANSFORM, []);
    expect(entities).toHaveLength(0);
  });

  it("does not match name strings that merely contain 'crosswalk' as a substring", () => {
    // The regex anchors on `name="`, the optional [A-Z][a-z]* prefix, then
    // exactly `Crosswalk`. "PreCrosswalkArea" is not a Crosswalk-named object;
    // we'd reject it because nothing in the export pipeline emits that form,
    // and accepting it would create false positives.
    const xodr = xodrWithObjects(`
      <object id="suffixed" type="-1" name="CrosswalkArea" s="10" t="0" hdg="0" width="3" length="3"/>
    `);
    const { entities } = buildCrosswalks(xodr, TRANSFORM, []);
    expect(entities).toHaveLength(0);
  });

  it("skips zero-extent crosswalks (length=0 or width=0)", () => {
    // Same skip the overlay extractor applies — the candidate engine should
    // not anchor on a degenerate polygon.
    const xodr = xodrWithObjects(`
      <object id="zero-len" type="crosswalk" name="LadderCrosswalk" s="10" t="0" hdg="0" width="3" length="0"/>
      <object id="zero-wid" type="crosswalk" name="LadderCrosswalk" s="20" t="0" hdg="0" width="0" length="3"/>
      <object id="ok" type="crosswalk" name="LadderCrosswalk" s="30" t="0" hdg="0" width="3" length="3"/>
    `);
    const { entities } = buildCrosswalks(xodr, TRANSFORM, []);
    const ids = entities.map((e) => e.xodrObjectId);
    expect(ids).toEqual(["ok"]);
  });

  it("returns no entities and a warning for empty XODR text", () => {
    const { entities, warnings } = buildCrosswalks("", TRANSFORM, []);
    expect(entities).toHaveLength(0);
    expect(warnings.some((w) => w.includes("empty XODR text"))).toBe(true);
  });
});
