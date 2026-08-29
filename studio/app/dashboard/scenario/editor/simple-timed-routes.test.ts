import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { EditorDocument } from "@simforge-oss/editor";
import type { Interaction } from "@simforge-oss/scenario";

import {
  armActorSimpleTimedRoute,
  EDITOR_EXPERIENCE_STORAGE_KEY,
  readEditorExperience,
} from "./simple-timed-routes";

function placementDocument(): EditorDocument {
  const interactions: Interaction[] = [{
    id: "compiled-lane-route",
    actor: "car-1",
    label: "Follow lanes",
    trigger: { kind: "at", t: 0 },
    verb: "route",
    target: { mode: "lanePath", lanes: ["lane-1"] },
  }];
  const data = {
    roles: [{
      id: "car-1",
      kind: "scene_absolute",
      actor: { static: false },
      pose: { position: { x: 12.3456, y: 0, z: -7.8912 } },
    }],
    choreography: { clipSeconds: 20, interactions },
  };
  return {
    data,
    actor: () => ({ x: 12.3456, z: -7.8912 }),
    addInteraction: (interaction: Interaction) => interactions.push(interaction),
    removeInteraction: (id: string) => {
      const index = interactions.findIndex((interaction) => interaction.id === id);
      if (index >= 0) interactions.splice(index, 1);
    },
    replaceInteraction: (id: string, interaction: Interaction) => {
      const index = interactions.findIndex((candidate) => candidate.id === id);
      if (index >= 0) interactions.splice(index, 1, interaction);
    },
  } as unknown as EditorDocument;
}

describe("Simple editor experience", () => {
  it("defaults a fresh session to Simple and preserves an Advanced choice", () => {
    assert.equal(readEditorExperience({ getItem: () => null }), "simple");
    assert.equal(readEditorExperience({
      getItem: (key) => key === EDITOR_EXPERIENCE_STORAGE_KEY ? "advanced" : null,
    }), "advanced");
  });

  it("replaces a placed car's compiled lane route with an unconfigured timed route", () => {
    const document = placementDocument();

    assert.equal(armActorSimpleTimedRoute(document, "car-1"), true);
    assert.equal(document.data.choreography.interactions.length, 1);
    assert.deepEqual(document.data.choreography.interactions[0], {
      id: "simple_timed_route_car-1",
      actor: "car-1",
      label: "Simple timed route",
      trigger: { kind: "at", t: 0 },
      until: { kind: "at", t: 20 },
      verb: "route",
      target: {
        mode: "customTimedRoute",
        points: [
          { timeS: 0, x: 12.346, z: -7.891 },
          { timeS: 1, x: 12.346, z: -7.891 },
        ],
      },
    });
  });
});
