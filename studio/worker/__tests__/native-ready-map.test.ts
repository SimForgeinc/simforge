import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { HifiPreviewFailure, resolveNativeReadyMap } from "../native-ready-map";

const MAP_ID = "published-only-map";
const MAP_DIGEST = "a".repeat(64);
const ROAD_SOURCE_DIGEST = "b".repeat(64);

const published = [
  { relativePath: "3d/manifest.json", sha256: MAP_DIGEST },
  { relativePath: "3d/tiles/road.glb", sha256: ROAD_SOURCE_DIGEST },
];

describe("native-ready map resolution", () => {
  it("returns a typed error instead of handing a published-only GLB to Bevy", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-published-only-"));
    try {
      await assert.rejects(
        resolveNativeReadyMap({
          mapId: MAP_ID,
          mapDigest: MAP_DIGEST,
          published,
          roots: [root],
          allowBuild: false,
        }),
        (error: unknown) => {
          assert.ok(error instanceof HifiPreviewFailure);
          assert.equal(error.code, "native_payload_unavailable");
          assert.deepEqual(error.detail, {
            mapId: MAP_ID,
            mapDigest: MAP_DIGEST,
            buildPermitted: false,
          });
          return true;
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses only a corpus entry pinned to the published source digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "simforge-native-ready-"));
    const corpusDir = join(root, MAP_ID, MAP_DIGEST);
    const roadPath = join(corpusDir, "tiles", "road.glb");
    try {
      await mkdir(join(corpusDir, "tiles"), { recursive: true });
      await writeFile(roadPath, "decoded-native-road");
      await writeFile(join(corpusDir, "manifest.json"), JSON.stringify({
        schema: "sensor-corpus.v1",
        mapId: MAP_ID,
        files: [{
          path: "tiles/road.glb",
          sha256: "c".repeat(64),
          srcSha256: ROAD_SOURCE_DIGEST,
          kind: "glb",
        }],
      }));

      const resolved = await resolveNativeReadyMap({
        mapId: MAP_ID,
        mapDigest: MAP_DIGEST,
        published,
        roots: [root],
        allowBuild: false,
      });
      assert.equal(resolved.corpusDir, corpusDir);
      assert.equal(resolved.mapDigest, MAP_DIGEST);
      assert.deepEqual(resolved.payloads, [{
        relativePath: "tiles/road.glb",
        path: roadPath,
        sourceSha256: ROAD_SOURCE_DIGEST,
        sha256: "c".repeat(64),
      }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
