/**
 * Where the imported draft's map identity comes from.
 *
 * Three sources, in a fixed order: an explicit caller option, the
 * `[simforge:...]` provenance our writer stamps into
 * `FileHeader@description`, and last the LogicFile basename. The order is the
 * whole point — for one of OUR exports the LogicFile is the XODR artifact's
 * filename, which is not a map name at all, so a reader that trusted it
 * would resolve the wrong map (or none) for exactly the files we wrote.
 */

import { describe, expect, it } from "vitest";
import { importXoscToDraft } from "../index";

const NOW = "2026-07-24T00:00:00Z";

function xosc(description: string, logicFile = "san-ramon-part-1_20260522-091430.xodr"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSCENARIO>
  <FileHeader revMajor="1" revMinor="0" date="GOLDEN" description="${description}" author="SimForge"/>
  <RoadNetwork><LogicFile filepath="${logicFile}"/></RoadNetwork>
  <Entities>
    <ScenarioObject name="ego">
      <Vehicle name="vehicle.lincoln.mkz" vehicleCategory="car">
        <BoundingBox>
          <Center x="1.6" y="0" z="0.7"/>
          <Dimensions width="2.1" length="4.9" height="1.5"/>
        </BoundingBox>
      </Vehicle>
    </ScenarioObject>
  </Entities>
  <Storyboard>
    <Init><Actions>
      <Private entityRef="ego">
        <PrivateAction><TeleportAction><Position>
          <WorldPosition x="1" y="2" z="0.5" h="0" p="0" r="0"/>
        </Position></TeleportAction></PrivateAction>
      </Private>
    </Actions></Init>
    <Story name="MainStory"><Act name="MainAct">
      <StartTrigger><ConditionGroup>
        <Condition name="act_start" delay="0" conditionEdge="none">
          <ByValueCondition><SimulationTimeCondition value="0" rule="greaterOrEqual"/></ByValueCondition>
        </Condition>
      </ConditionGroup></StartTrigger>
    </Act></Story>
    <StopTrigger><ConditionGroup>
      <Condition name="stop_on_duration" delay="0" conditionEdge="rising">
        <ByValueCondition><SimulationTimeCondition value="20" rule="greaterOrEqual"/></ByValueCondition>
      </Condition>
    </ConditionGroup></StopTrigger>
  </Storyboard>
</OpenSCENARIO>`;
}

const EMBEDDED = "dsc_123 [simforge:map_asset=ma_san_ramon;map=San_Ramon_Phase_1_P1]";

describe("embedded FileHeader provenance", () => {
  it("is surfaced separately from the resolved draft metadata", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), { now: NOW });
    expect(result.embeddedMetadata).toEqual({
      mapAssetId: "ma_san_ramon",
      mapName: "San_Ramon_Phase_1_P1",
    });
  });

  it("is null for a foreign file, so a caller can tell the two apart", () => {
    const result = importXoscToDraft(xosc("Highway merge"), { now: NOW });
    expect(result.embeddedMetadata).toEqual({ mapAssetId: null, mapName: null });
  });

  it("supplies the map asset id and map name when the caller gives none", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), { now: NOW });
    expect(result.draft.metadata.mapAssetId).toBe("ma_san_ramon");
    expect(result.draft.metadata.mapName).toBe("San_Ramon_Phase_1_P1");
  });

  it("does not leak the group into the source scenario id", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), { now: NOW });
    expect(result.draft.metadata.sourceScenarioId).toBe("dsc_123");
  });

  it("silences the metadata_defaulted diagnostic that a bare file earns", () => {
    const withProvenance = importXoscToDraft(xosc(EMBEDDED), { now: NOW });
    expect(
      withProvenance.diagnostics.some(
        (entry) =>
          entry.code === "metadata_defaulted" && entry.detail.includes("mapAssetId"),
      ),
    ).toBe(false);

    const without = importXoscToDraft(xosc("Highway merge"), { now: NOW });
    expect(
      without.diagnostics.some(
        (entry) =>
          entry.code === "metadata_defaulted" && entry.detail.includes("mapAssetId"),
      ),
    ).toBe(true);
  });
});

describe("precedence", () => {
  it("prefers an explicit caller option over the embedded id", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), {
      now: NOW,
      mapAssetId: "ma_override",
      mapName: "Override_Map",
    });
    expect(result.draft.metadata.mapAssetId).toBe("ma_override");
    expect(result.draft.metadata.mapName).toBe("Override_Map");
    // The FILE still reports what it carried — the caller's override does not
    // rewrite history.
    expect(result.embeddedMetadata.mapAssetId).toBe("ma_san_ramon");
  });

  it("prefers the embedded map name over the LogicFile basename", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), { now: NOW });
    expect(result.draft.metadata.mapName).toBe("San_Ramon_Phase_1_P1");
    expect(result.logicFile).toBe("san-ramon-part-1_20260522-091430.xodr");
  });

  it("falls back to the LogicFile basename when nothing is embedded", () => {
    const result = importXoscToDraft(xosc("Highway merge", "Town03.xodr"), {
      now: NOW,
    });
    expect(result.draft.metadata.mapName).toBe("Town03");
    expect(result.draft.metadata.mapAssetId).toBe("");
  });

  it("takes an explicit map name over an embedded one even with no asset id", () => {
    const result = importXoscToDraft(xosc("plain [simforge:map=Embedded]"), {
      now: NOW,
      mapName: "Explicit",
    });
    expect(result.draft.metadata.mapName).toBe("Explicit");
    expect(result.draft.metadata.mapAssetId).toBe("");
  });

  it("keeps an explicit sourceScenarioId ahead of the file's description", () => {
    const result = importXoscToDraft(xosc(EMBEDDED), {
      now: NOW,
      sourceScenarioId: "scn_caller",
    });
    expect(result.draft.metadata.sourceScenarioId).toBe("scn_caller");
  });
});

describe("canonical OpenSCENARIO preflight", () => {
  it("surfaces the canonical error code for non-OpenSCENARIO input", () => {
    const result = importXoscToDraft("not xml at all", { now: NOW });
    expect(result.embeddedMetadata).toEqual({ mapAssetId: null, mapName: null });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("malformed_xml"),
      }),
    );
  });

  it("uses the canonical bounded parser to reject DTDs and entities", () => {
    const result = importXoscToDraft(
      '<!DOCTYPE OpenSCENARIO [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><OpenSCENARIO/>',
      { now: NOW },
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("xml_declarations_forbidden"),
      }),
    );
  });
});
