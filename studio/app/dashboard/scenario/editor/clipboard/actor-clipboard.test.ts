import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActorRecord } from "@simforge-oss/editor";
import {
  buildClipboardPayload,
  parseClipboardPayload,
  pastedRoutePoints,
  planPaste,
  selectionCentroid,
} from "./actor-clipboard";

function actor(id: string, x: number, z: number): ActorRecord {
  return {
    id,
    source: "role",
    kind: "vehicle",
    catalogId: "vehicle.sedan" as ActorRecord["catalogId"],
    x,
    y: 0,
    z,
    headingRad: 0,
    dims: { l: 4.7, w: 1.8, h: 1.5 },
    sensors: [],
  } as ActorRecord;
}

describe("actor clipboard", () => {
  it("preserves a copied group's relative layout at a new cursor anchor", () => {
    assert.deepEqual(selectionCentroid([{ x: 10, z: 0 }, { x: 30, z: 20 }]), { x: 20, z: 10 });
    const payload = buildClipboardPayload({
      actors: [actor("a", 10, 0), actor("b", 30, 20)],
      interactions: [],
      sourceMapId: "starter",
    });
    assert.ok(payload);
    assert.deepEqual(planPaste(payload, { x: 100, z: 50 }).map(({ x, z }) => ({ x, z })), [
      { x: 90, z: 40 },
      { x: 110, z: 60 },
    ]);
    assert.deepEqual(parseClipboardPayload(JSON.stringify(payload)), payload);
  });

  it("rejects foreign clipboard text instead of hijacking native paste", () => {
    assert.equal(parseClipboardPayload("plain text"), null);
    assert.equal(parseClipboardPayload(JSON.stringify({ schema: "foreign" })), null);
  });

  it("translates route geometry with its actor and pins a timed start", () => {
    const points = pastedRoutePoints(
      {
        mode: "customTimedRoute",
        points: [
          { timeS: 0, dx: 5, dz: 0 },
          { timeS: 1, dx: 9, dz: 0 },
        ],
      },
      { catalogId: "vehicle.sedan", dx: 5, dz: 0, y: 0, headingRad: 0, routes: [] },
      { x: 103, z: 1 },
    );
    assert.deepEqual(points, [
      { timeS: 0, x: 103, z: 1 },
      { timeS: 1, x: 107, z: 1 },
    ]);
  });
});
