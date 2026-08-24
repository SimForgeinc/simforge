import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeXodrForEsmini,
  normalizeXodrForEsminiWithStats,
} from "../xodr-signal-controllers";

const FIXTURE = readFileSync(join(__dirname, "fixtures/xodr/signalized-4way.xodr"), "utf8");

/**
 * The esmini v3.1.0 controllability gate, restated: country lowercases to
 * "opendrive", no countryRevision attribute, dynamic="yes".
 * (RoadManager.cpp:4789-4791 for the inverted revision read, :4857 for the gate.)
 */
function esminiControllableIds(xodr: string): string[] {
  const ids: string[] = [];
  const tagRe = /<signal\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(xodr)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRe = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(match[1]!)) !== null) attrs[a[1]!] = a[2]!;
    if ((attrs.dynamic ?? "").toLowerCase() !== "yes") continue;
    if ((attrs.country ?? "").toLowerCase() !== "opendrive") continue;
    if ("countryRevision" in attrs) continue;
    if (attrs.id) ids.push(attrs.id);
  }
  return ids;
}

describe("normalizeXodrForEsmini", () => {
  it("makes every dynamic light in the realistic fixture esmini-controllable", () => {
    // The fixture ships country="OpenDRIVE" countryRevision="2010", which is
    // the shape esmini rejects: a present countryRevision pins the revision to
    // the 2013 default regardless of its value.
    expect(esminiControllableIds(FIXTURE)).toEqual([]);

    const { xodr, stats } = normalizeXodrForEsminiWithStats(FIXTURE);

    expect(stats.traffic_lights_seen).toBeGreaterThan(0);
    expect(stats.traffic_lights_rewritten).toBe(stats.traffic_lights_seen);
    expect(esminiControllableIds(xodr)).toHaveLength(stats.traffic_lights_seen);
    // The only countryRevision left belongs to the static sign (see below).
    expect(xodr.match(/countryRevision/gi)).toHaveLength(1);
  });

  it("leaves non-light signals untouched", () => {
    // id 950 is a static Sign_R2-1 (dynamic="no", type 274): not a traffic
    // light, so its country metadata must survive verbatim.
    const normalized = normalizeXodrForEsmini(FIXTURE);
    expect(normalized).toContain(
      'id="950" name="Sign_R2-1" dynamic="no" orientation="+" zOffset="2.2" country="OpenDRIVE" countryRevision="2010"',
    );
  });

  it("passes a no-signal document through byte-identically", () => {
    const xodr = [
      '<?xml version="1.0" standalone="yes"?>',
      "<OpenDRIVE>",
      '  <header revMajor="1" revMinor="6" name="plain" version="1.00" vendor="test"/>',
      '  <road name="Road 1" length="100.0" id="1" junction="-1">',
      "    <signals/>",
      "  </road>",
      "</OpenDRIVE>",
    ].join("\n");
    expect(normalizeXodrForEsmini(xodr)).toBe(xodr);
  });

  it("is idempotent", () => {
    const once = normalizeXodrForEsmini(FIXTURE);
    const twice = normalizeXodrForEsmini(once);
    expect(twice).toBe(once);
    expect(normalizeXodrForEsminiWithStats(once).stats.traffic_lights_rewritten).toBe(0);
  });

  it("adds country when absent, whatever the attribute order or tag form", () => {
    // RoadRunner writes no country attribute at all and closes <signal> with a
    // child <validity>; other exporters self-close and lead with country.
    const roadRunner = '<signal name="Signal_3Light_Post01" id="7" dynamic="yes" type="1000001">';
    const selfClosing = '<signal country="DEU" countryRevision="2020" id="8" dynamic="yes" type="1000011.1" />';

    const out = normalizeXodrForEsmini(`<OpenDRIVE>${roadRunner}</signal>${selfClosing}</OpenDRIVE>`);

    expect(out).toContain(
      '<signal name="Signal_3Light_Post01" id="7" dynamic="yes" type="1000001" country="OpenDRIVE">',
    );
    expect(out).toContain('<signal country="OpenDRIVE" id="8" dynamic="yes" type="1000011.1" />');
    expect(esminiControllableIds(out)).toEqual(["7", "8"]);
  });

  it("does not touch <signals> containers or <signalReference> elements", () => {
    const xodr =
      '<signals><signalReference s="1.0" t="-2.0" id="900" orientation="+"/></signals>';
    expect(normalizeXodrForEsmini(xodr)).toBe(xodr);
  });
});
