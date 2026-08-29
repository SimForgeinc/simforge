/**
 * The FileHeader provenance carrier.
 *
 * Two properties matter and everything here is one of them:
 *
 * 1. **Round trip.** Anything encoded reads back identically, including ids and
 *    map names containing the delimiters (`;`, `]`, `%`) and whitespace.
 * 2. **Fail open.** A description with no group, a malformed group, a foreign
 *    tool's prose — none of them throw, and none of them invent metadata.
 */
import { describe, expect, it } from "vitest";
import {
  encodeXoscFileHeaderDescription,
  parseXoscFileHeaderDescription,
  stripXoscFileHeaderMetadata,
} from "../file-header-metadata";

describe("encodeXoscFileHeaderDescription", () => {
  it("appends a structured group after the human description", () => {
    expect(
      encodeXoscFileHeaderDescription({
        description: "scn_golden",
        mapAssetId: "map_golden",
        mapName: "Town03",
      }),
    ).toBe("scn_golden [simforge:map_asset=map_golden;map=Town03]");
  });

  it("leaves a description with no map metadata exactly as it was", () => {
    expect(
      encodeXoscFileHeaderDescription({ description: "scn_golden" }),
    ).toBe("scn_golden");
    expect(
      encodeXoscFileHeaderDescription({
        description: "scn_golden",
        mapAssetId: "   ",
        mapName: null,
      }),
    ).toBe("scn_golden");
  });

  it("emits only the keys it has", () => {
    expect(
      encodeXoscFileHeaderDescription({ description: "x", mapAssetId: "ma_1" }),
    ).toBe("x [simforge:map_asset=ma_1]");
    expect(
      encodeXoscFileHeaderDescription({ description: "x", mapName: "Town03" }),
    ).toBe("x [simforge:map=Town03]");
  });

  it("emits the group alone when there is no description", () => {
    expect(
      encodeXoscFileHeaderDescription({ description: "", mapAssetId: "ma_1" }),
    ).toBe("[simforge:map_asset=ma_1]");
  });

  it("replaces an existing group rather than nesting one inside the next", () => {
    const once = encodeXoscFileHeaderDescription({
      description: "scn",
      mapAssetId: "ma_1",
      mapName: "A",
    });
    const twice = encodeXoscFileHeaderDescription({
      description: once,
      mapAssetId: "ma_2",
      mapName: "B",
    });
    expect(twice).toBe("scn [simforge:map_asset=ma_2;map=B]");
  });
});

describe("parseXoscFileHeaderDescription", () => {
  it("splits the human description from the metadata", () => {
    expect(
      parseXoscFileHeaderDescription(
        "scn_golden [simforge:map_asset=map_golden;map=Town03]",
      ),
    ).toEqual({
      description: "scn_golden",
      mapAssetId: "map_golden",
      mapName: "Town03",
    });
  });

  it("reads a foreign file as description-only", () => {
    expect(
      parseXoscFileHeaderDescription("Highway merge, cut-in at 40 m"),
    ).toEqual({
      description: "Highway merge, cut-in at 40 m",
      mapAssetId: null,
      mapName: null,
    });
  });

  it("treats a missing or empty description as no metadata", () => {
    for (const input of [null, undefined, ""]) {
      expect(parseXoscFileHeaderDescription(input)).toEqual({
        description: "",
        mapAssetId: null,
        mapName: null,
      });
    }
  });

  it("ignores unknown keys, which is what makes the format extensible", () => {
    expect(
      parseXoscFileHeaderDescription(
        "scn [simforge:map_asset=ma_1;future_key=whatever;map=Town03]",
      ),
    ).toEqual({ description: "scn", mapAssetId: "ma_1", mapName: "Town03" });
  });

  it("strips a group with nothing readable in it", () => {
    expect(parseXoscFileHeaderDescription("scn [simforge:]")).toEqual({
      description: "scn",
      mapAssetId: null,
      mapName: null,
    });
    expect(parseXoscFileHeaderDescription("scn [simforge:garbage]")).toEqual({
      description: "scn",
      mapAssetId: null,
      mapName: null,
    });
  });

  it("only reads a group anchored at the end", () => {
    // Brackets earlier in the text are the author's, not ours.
    expect(
      parseXoscFileHeaderDescription("[simforge:map_asset=ma_1] trailing prose"),
    ).toEqual({
      description: "[simforge:map_asset=ma_1] trailing prose",
      mapAssetId: null,
      mapName: null,
    });
  });

  it("survives a stray percent rather than losing the field", () => {
    expect(
      parseXoscFileHeaderDescription("scn [simforge:map=100%pure]").mapName,
    ).toBe("100%pure");
  });
});

describe("round trip", () => {
  const CASES: Array<{ description: string; mapAssetId: string; mapName: string }> = [
    { description: "scn_1", mapAssetId: "ma_plain", mapName: "Town03" },
    {
      description: "dsc_f38689a3b8a7452394c99062",
      mapAssetId: "9f2b8f1e-0000-4a11-8e2c-5b1f0d2a7c33",
      mapName: "Richmond_Field_Station_Richmond_CA",
    },
    // The delimiters themselves, which percent-encoding exists for.
    { description: "has ] bracket", mapAssetId: "a;b]c%d", mapName: "x y z" },
    { description: "", mapAssetId: "ma_only", mapName: "M" },
  ];

  it.each(CASES)("survives $mapAssetId", (input) => {
    const encoded = encodeXoscFileHeaderDescription(input);
    const parsed = parseXoscFileHeaderDescription(encoded);
    expect(parsed.mapAssetId).toBe(input.mapAssetId);
    expect(parsed.mapName).toBe(input.mapName);
    // A description that itself ends in a bracket group is the one case the
    // human half cannot be recovered verbatim — the encoder strips it first,
    // which is what stops nesting. Everything else comes back exact.
    expect(parsed.description).toBe(stripXoscFileHeaderMetadata(input.description));
  });

  it("is idempotent — encoding a parsed description changes nothing", () => {
    const once = encodeXoscFileHeaderDescription({
      description: "scn",
      mapAssetId: "ma_1",
      mapName: "Town03",
    });
    const parsed = parseXoscFileHeaderDescription(once);
    expect(
      encodeXoscFileHeaderDescription({
        description: parsed.description,
        mapAssetId: parsed.mapAssetId,
        mapName: parsed.mapName,
      }),
    ).toBe(once);
  });
});

describe("stripXoscFileHeaderMetadata", () => {
  it("removes the group and trims", () => {
    expect(stripXoscFileHeaderMetadata("scn  [simforge:map=A]  ")).toBe("scn");
  });

  it("leaves text with no group alone", () => {
    expect(stripXoscFileHeaderMetadata("just a description")).toBe(
      "just a description",
    );
  });
});
