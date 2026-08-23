import { describe, expect, it } from "vitest";

import { classifyXoscDocument } from "../xosc/allowlist-self-check";

describe("classifyXoscDocument", () => {
  it("classifies known writer actions and conditions as faithful", () => {
    const result = classifyXoscDocument(`<?xml version="1.0"?>
      <OpenSCENARIO>
        <Storyboard>
          <Init><Actions><PrivateAction><TeleportAction/></PrivateAction></Actions></Init>
          <Story><Act>
            <ManeuverGroup><Maneuver><Event>
              <Action><PrivateAction><LongitudinalAction><SpeedAction/></LongitudinalAction></PrivateAction></Action>
              <StartTrigger><ConditionGroup><Condition><ByValueCondition><SimulationTimeCondition/></ByValueCondition></Condition></ConditionGroup></StartTrigger>
            </Event></Maneuver></ManeuverGroup>
          </Act></Story>
        </Storyboard>
      </OpenSCENARIO>`);

    expect(result.verdict).toBe("faithful");
    expect(result.actions).toEqual([
      "PrivateAction",
      "TeleportAction",
      "Action",
      "LongitudinalAction",
      "SpeedAction",
    ]);
    expect(result.conditions).toEqual([
      "Condition",
      "ByValueCondition",
      "SimulationTimeCondition",
    ]);
    expect(result.unknownElements).toEqual([]);
  });

  it("classifies an unknown action as unsupported", () => {
    const result = classifyXoscDocument(
      "<OpenSCENARIO><Storyboard><MagicAction/></Storyboard></OpenSCENARIO>",
    );

    expect(result.verdict).toBe("unsupported");
    expect(result.unknownElements).toEqual(["MagicAction"]);
  });

  it("throws a clear error for malformed XML", () => {
    expect(() =>
      classifyXoscDocument(
        "<OpenSCENARIO><Action></OpenSCENARIO>",
      ),
    ).toThrow(/Malformed OpenSCENARIO XML: closing <\/OpenSCENARIO> does not match <Action>/);
  });
});
