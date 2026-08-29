import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TruthFrame } from "@simforge-oss/training-env/browser";

import { driveSumoUnavailableReason, truthFrameSumoExternalActors } from "./useDriveAmbientTraffic";

describe("Drive ambient traffic bridge", () => {
  it("names the missing immutable map artifact", () => {
    assert.equal(
      driveSumoUnavailableReason(
        { label: "Richmond Field Station", sumoNetworkSha256: null },
        false,
      ),
      "SUMO cannot run on Richmond Field Station: the published map is missing derived/sumo/sumo-network-manifest.json and its immutable network digest. Republish the map with SUMO artifacts.",
    );
  });

  it("keeps authored truth actors external to SUMO", () => {
    const frame = {
      actors: [
        { id: "car-1", class: "vehicle", dims: { l: 4.8, w: 1.9, h: 1.6 } },
        { id: "gone", class: "vehicle", dims: { l: 4.2, w: 1.8, h: 1.5 } },
      ],
      scene: {
        actors: [
          {
            id: "car-1",
            kind: "upsert",
            position: [12, 0, -7],
            velocity: [3, 0, 4],
            yawRad: 0.75,
          },
          {
            id: "gone",
            kind: "despawn",
            position: [0, 0, 0],
            velocity: [0, 0, 0],
            yawRad: 0,
          },
        ],
      },
    } as unknown as TruthFrame;

    assert.deepEqual(truthFrameSumoExternalActors(frame), [
      {
        id: "car-1",
        kind: "vehicle",
        x: 12,
        z: -7,
        headingRad: 0.75,
        speedMps: 5,
        lengthM: 4.8,
        widthM: 1.9,
        static: false,
        present: true,
      },
    ]);
  });
});
